import https = require('https');

const httpsRequest = (options, requestData: string | Buffer) => {
    return new Promise((resolve, reject) => {
        const request = https.request(options, res => {
            if (res.statusCode !== 200)
                return reject('HTTP Error: ' + res.statusCode);

            let data = '';

            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                return resolve(data);
            });
        });

        request.on('error', (error) => {
            return reject(error);
        });

        // Send the data
        if (requestData) {
            request.write(requestData);
        }

        request.end();
    });
};


export function notifySlack(hookPath: string, payload: string | Buffer) {
    const options = {
        method: 'POST',
        port: 443,
        hostname: 'hooks.slack.com',
        path: hookPath,
        headers: {
            Accept: 'application/json',
            'User-Agent': 'Build-App'
        }
    };

    return httpsRequest(options, payload);
};
