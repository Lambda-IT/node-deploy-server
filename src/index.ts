import { configuration, OptionalConfigurations, Config } from './config';
import { notifySlack } from './http-service';

import * as _ from 'lodash';
import * as simpleGit from 'simple-git';
import * as simpleGitP from 'simple-git/promise';
import { Observable, BehaviorSubject } from 'rxjs';
import { exec } from 'child_process';
import * as BPromise from 'bluebird';

// Use js.map files for better error stacktrace
require('source-map-support').install();

interface Branch {
    current?: boolean;
    name: string;
    commit: string;
    label: string;
}
type BuildTask = {
    [name: string]: string[];
};
type TaskProgress = {
    [name: string]: {
        done: boolean;
        error: any;
    };
};
enum DeploySteps {
    Build,
    Test,
    Deploy,
    PostDeploy,
    Restart,
    PostTasks,
}

function getCurrentDate() {
    return new Date().toISOString();
}

function execParallel(buildTasks: BuildTask, buildPath: string) {
    const tasks = Object.keys(buildTasks);
    const progress: TaskProgress = tasks.reduce((acc, task) => ({ ...acc, [task]: { done: false } }), {});
    return BPromise.mapSeries(tasks, task => {
        return BPromise.map(buildTasks[task], command => execAsync(command, buildPath))
            .then(result => {
                console.log(`[deploy] ${task} - Completed`);
                progress[task].done = true;
                return result;
            })
            .catch(error => {
                console.error(`[deploy] ${task} - failed`, error);
                progress[task].error = error;
                throw progress;
            });
    })
        .then(results => results.reduce((acc, cur) => [...acc, ...cur], []))
        .catch(error => {
            throw { aggregateErrors: error };
        });
}

function execAsync(args, buildPath: string | null = null) {
    return new BPromise(function(resolve, reject) {
        function callback(error, stdout, stderr) {
            if (error) {
                console.error(`[deploy] X "${args}"`, error);
                const commandStr = args[0] + (Array.isArray(args[1]) ? ' ' + args[1].join(' ') : '');
                error.message += ' `' + commandStr + '` (exited with error code ' + error.code + ')';
                error.stdout = stdout;
                error.stderr = stderr;
                const cpError = {
                    error: error,
                    stdout: stdout,
                    stderr: stderr,
                };
                reject(cpError);
            } else {
                console.log(`[deploy] ✓ "${args}"`);
                resolve({
                    stdout: stdout,
                    stderr: stderr,
                });
            }
        }

        const cp = exec(
            args,
            { cwd: buildPath, env: { ...process.env, ...configuration.environmentVariables } },
            callback,
        );
    });
}

function getCurrentBranch(): BPromise<Branch> {
    return new BPromise((resolve, reject) => {
        simpleGit(configuration.path).branch((error, result) => {
            if (error) {
                reject(error);
            } else {
                resolve(result.branches[result.current]);
            }
        });
    });
}

function resetRepo() {
    return new BPromise((resolve, reject) => {
        simpleGit(configuration.path).reset('hard', (error, result) => {
            if (error) {
                reject(error);
            } else {
                resolve(result);
            }
        });
    });
}

function cleanRepo() {
    return new BPromise((resolve, reject) => {
        simpleGit(configuration.path).clean('f', (error, result) => {
            if (error) {
                reject(error);
            } else {
                resolve(result);
            }
        });
    });
}

const processing$ = new BehaviorSubject(false);

checkConfigIsValid();

Observable.interval(configuration.poll * 1000)
    .withLatestFrom(processing$.asObservable(), (i, isProcessing) => isProcessing)
    .startWith(false)
    .filter(isProcessing => !isProcessing)
    .flatMap(async () => {
        console.log(`[git] ${new Date().toTimeString()} Fetching from remote for branch ${configuration.branch}`);
        const repo = simpleGitP(configuration.path);

        const currentBranch = await getCurrentBranch();
        if (currentBranch.name !== configuration.branch) {
            console.log(
                `[git] ${new Date().toTimeString()} Not on correct branch, switching from ${currentBranch.name} to ${
                    configuration.branch
                }`,
            );
            await repo.checkout(configuration.branch);
        }

        await repo.fetch();

        const behind = (await repo.status()).behind;
        console.log(`[git] Repository is ${behind} commit(s) behind`);
        if (behind > 0 || configuration.isDebug) {
            processing$.next(true);
            await resetRepo();
            await cleanRepo();

            console.log(`[git] Pulling from remote`);
            await repo.pull();
            const branch = await getCurrentBranch();
            await build(branch);
        }
    })
    .retryWhen(errors => errors.delay(configuration.poll * 1000).take(10))
    .subscribe();

processing$
    .asObservable()
    .skip(1)
    .subscribe(x => {
        console.log('[deploy] Processing state changed:', x);
    });

function build(branch) {
    const deploySteps = [
        DeploySteps.Build,
        DeploySteps.Test,
        DeploySteps.Deploy,
        DeploySteps.PostDeploy,
        DeploySteps.Restart,
        ...(configuration.postTasks ? [DeploySteps.PostDeploy] : []),
    ];
    let currentStep: DeploySteps = DeploySteps.Build;

    console.log(`[deploy] ${getCurrentDate()} - Start processing`, branch);
    return BPromise.resolve()
        .then(() => {
            console.log('[deploy] Build started');
            return execParallel(configuration.buildScript, configuration.buildPath);
        })
        .then((buildResult: any) => {
            console.log('[deploy] Build done');
            console.log('[deploy] BuildResult:', buildResult);
        })
        .then(() => {
            if (!configuration.testScript) {
                return;
            }

            console.log('[deploy] Testing started');
            currentStep = DeploySteps.Test;
            return execParallel(configuration.testScript, configuration.buildPath).then((testResult: any) => {
                console.log('[deploy] Testing done');
                console.log('[deploy] TestResult:', testResult);
            });
        })
        .then(() => {
            console.log('[deploy] Deploying started');
            currentStep = DeploySteps.Deploy;
            return execAsync(`rsync -rtl ${configuration.buildPath} ${configuration.deployPath}`);
        })
        .then((deployResult: any) => {
            console.log('[deploy] Deploying done');
            console.log('[deploy] DeployResult:', deployResult);
        })
        .then(() => {
            if (!configuration.commitTag) {
                return;
            }

            console.log('[deploy] Post Deploy started');
            currentStep = DeploySteps.PostDeploy;

            return execAsync(
                `grep -rli --exclude-dir=node_modules '${configuration.commitTag}' ${
                    configuration.deployPath
                } | xargs sed -i '' 's/${configuration.commitTag}/${branch.commit}/'`,
            ).then((markCommitResult: any) => {
                console.log('[deploy] Post Deploy done');
                console.log('[deploy] PostDeployResult:', markCommitResult);
            });
        })
        .then(() => {
            if (!configuration.restartScript) {
                return;
            }

            // restart servers
            console.log('[deploy] Restarting started');
            currentStep = DeploySteps.Restart;

            return execAsync(`${configuration.restartScript}`).then((restartResult: any) => {
                if (restartResult) {
                    console.log('[deploy] Restarting done');
                    console.log('[deploy] RestartResult:', restartResult);
                }
            });
        })
        .then(() => {
            console.log(
                `[deploy] ${getCurrentDate()} - DEPLOYEMENT SUCCESS!, commit: ${branch.label}, ${branch.commit}`,
            );
            const text = configuration.successText + '\ncommit:' + branch.label + ', ' + branch.commit;
            const msg = {
                ...formatProgress(text, deploySteps, currentStep),
                channel: configuration.slackChannel,
                username: configuration.slackUser,
                icon_emoji: ':simple_smile:',
            };

            if (!configuration.isDebug && configuration.successText) {
                return notifySlack(configuration.slackPath, JSON.stringify(msg)).then(notification => ({
                    success: true,
                    notification,
                }));
            } else {
                console.log('[deploy] Slack message:', JSON.stringify(msg, null, 2));
                return { success: true, notification: null };
            }
        })
        .catch(error => {
            console.error(`[deploy] ${getCurrentDate()} - DEPLOYMENT FAILED, commit: ${branch.commit}`, error);
            console.error(`[deploy] ERROR Log: ${error.stderr || error}`);

            const text = configuration.failedText + '\ncommit:' + branch.label + ', ' + branch.commit;
            return handleError(error, text, deploySteps, currentStep);
        })
        .then(async ({ success, notification }) => {
            if (success && configuration.postTasks) {
                console.log('[deploy] Post Tasks started');
                currentStep = DeploySteps.PostTasks;
                await execParallel(configuration.postTasks, configuration.buildPath)
                    .then(() => {
                        console.log('[deploy] Post Tasks done');
                    })
                    .catch(error => {
                        console.error(
                            `[deploy] ${getCurrentDate()} - POST TASKS FAILED, commit: ${branch.commit}`,
                            error,
                        );
                        console.error(`[deploy] ERROR Log: ${error.stderr || error}`);

                        const text =
                            '[Post tasks] ' +
                            configuration.failedText +
                            '\ncommit:' +
                            branch.label +
                            ', ' +
                            branch.commit;
                        return handleError(error, text, deploySteps, currentStep);
                    });
            }
            return notification;
        })
        .finally(() => {
            processing$.next(false);
        });
}

function formatAggregateErrors(errors: any) {
    const indicator = result =>
        result.error ? ':small_red_triangle_down:' : result.done ? ':black_small_square:' : ':white_small_square:';
    return Object.keys(errors)
        .map(task => {
            const result = errors[task];
            return indicator(result) + ` ${task}` + (result.error ? `\n${formatError(result.error)}` : '');
        })
        .join('\n');
}

function formatError(error) {
    if (error.error && error.error.cmd) {
        return `\`[${error.error.code}] ${error.error.cmd}\`\n>\`\`\`STDOUT:\n${error.stdout}\`\`\`\n\`\`\`STDERR:\n${
            error.stderr
        }\`\`\``;
    }
    if (error.sterr) {
        return `\`\`\`STDOUT:\n${error.stdout}\`\`\`\n\`\`\`STDERR:\n${error.stderr}\`\`\``;
    }
    if (error.aggregateErrors) {
        return formatAggregateErrors(error.aggregateErrors);
    }
    return `UNEXPECTED ERROR:\n\`\`\`${error}\`\`\``;
}

function formatProgress(text: string, steps: DeploySteps[], currentStep: DeploySteps, error: any = null) {
    let hasFailed = false;
    const progress = steps.map(step => {
        hasFailed = hasFailed || (step === currentStep && error);
        const stepName = DeploySteps[step];
        if (step === currentStep && error) {
            hasFailed = true;
            return `:x: ${stepName}`;
        }
        return hasFailed ? `:double_vertical_bar: ${stepName}` : `:white_check_mark: ${stepName}`;
    });
    if (error) {
        return {
            attachments: [
                {
                    pretext: text,
                    color: error ? 'danger' : 'good',
                    title: 'ZEM Deployement',
                    text: progress.join('\n'),
                },
                {
                    color: 'warning',
                    mrkdwn_in: ['text'],
                    text: formatError(error),
                    title: 'Error details',
                },
            ],
        };
    }
    return {
        text: text,
    };
}

function checkConfigIsValid() {
    if (!configuration) {
        throw Error('Configuration does not exist.');
    }
    const hasMissingConfig = Object.keys(configuration)
        .filter(property => OptionalConfigurations.indexOf(property as keyof Config) === -1)
        .filter(property => configuration[property] === null);
    if (hasMissingConfig.length > 0) {
        throw Error('Configuration is missing following configurations: ' + hasMissingConfig.join(', '));
    }
}

function handleError(error: any, text: string, deploySteps: DeploySteps[], currentStep: DeploySteps) {
    let stdout = '' + error.stdout;
    if (stdout.length > 500) stdout = stdout.substr(-500);

    let errorLocal = '' + error.error;
    if (errorLocal.length > 1000) errorLocal = errorLocal.substr(-1000);
    const msg = {
        ...formatProgress(text, deploySteps, currentStep, error),
        channel: configuration.slackChannel,
        username: configuration.slackUser,
        icon_emoji: ':monkey_face:',
    };
    if (!configuration.isDebug) {
        return notifySlack(configuration.slackPath, JSON.stringify(msg)).then(notification => ({
            success: false,
            notification,
        }));
    } else {
        console.log('[deploy] Slack message:', JSON.stringify(msg, null, 2));
        return { success: false, notification: null };
    }
}
