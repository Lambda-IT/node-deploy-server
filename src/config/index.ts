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

    buildScript?: Steps;
    testScript?: Steps;
    postTasks?: Steps;
    restartScript?: string;

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
    slackPath: null,
    slackChannel: null,
    slackUser: null,
    failedText: 'Build failed!',
    successText: 'Build success!',
    poll: 60,
    strict: false,
    isDebug: false,
    remote: 'origin',
    branch: 'master',

    path: null,
    buildPath: null,
    deployPath: null,

    buildScript: null,
    testScript: null,
    postTasks: null,
    restartScript: null,

    environmentVariables: null,
    commitTag: null,
};

export const configuration: Config = {
    ...config,
    ...(require(`./${process.env.NODE_ENV || 'development'}`).config || {}),
};
