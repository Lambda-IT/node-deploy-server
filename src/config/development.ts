import { Config } from '.';

export const config: Partial<Config> = {
    slackUser: 'node-deploy-server',
    failedText: 'Build failed!',
    successText: 'Build success!',
    branch: 'master',
    isDebug: false,
    // buildScript: {
    //     'npm install': ['npm install'],
    // },
};
