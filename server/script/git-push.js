const { exec } = require('child_process');
const path = require('path');

const projectRoot = path.resolve(__dirname, '../..');

const runCommand = (cmd, cwd) => {
    return new Promise((resolve, reject) => {
        console.log(`> ${cmd}`);
        exec(cmd, { cwd, encoding: 'utf-8', maxBuffer: 1024 * 1024 * 5 }, (error, stdout, stderr) => {
            if (stdout) console.log(stdout);
            if (stderr) console.log(stderr);
            if (error) {
                console.error(`命令执行失败: ${error.message}`);
                reject(error);
            } else {
                resolve();
            }
        });
    });
};

(async () => {
    try {
        console.log(`进入项目目录: ${projectRoot}`);
        await runCommand('git add .', projectRoot);
        await runCommand("git commit -m '优化'", projectRoot);
        await runCommand('git push origin main', projectRoot);
        console.log('✅ 所有命令执行完成');
    } catch (error) {
        console.error('❌ 执行失败:', error.message);
        process.exit(1);
    }
})();