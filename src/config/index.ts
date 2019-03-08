import * as _ from 'lodash';

export const OptionalConfigurations: (keyof Config)[] = ['environmentVariables', 'commitTag', 'postTasks', 'testScript', 'buildPath'];

export type Config = {
    slackPath: string;
    slackChannel: string;
    slackUser: string;
    failedText: string;
    successText: string;
    poll: number;
    strict: boolean;
    isDebug: boolean;
    remote: string;

    branch: string;
    path: string;
    buildPath: string;
    deployPath: string;

    buildScript: Steps | null;
    testScript: Steps | null;
    postTasks: Steps | null;
    restartScript: string | null;

    environmentVariables?: EnvironmentVariables;
    commitTag?: string;
};

export type Steps = {
    [stepName: string]: string[];
};

export type EnvironmentVariables = {
    [envName: string]: string
};

const config: Partial<Config> = {
    failedText: 'Build failed!',
    successText: 'Build success!',
    poll: 60,
    remote: 'origin',
    branch: 'master',
    strict: false,
};

export const configuration: Config = {
    ...config,
    ...(require(`./${process.env.NODE_ENV || 'development'}`).config || {}),
};
