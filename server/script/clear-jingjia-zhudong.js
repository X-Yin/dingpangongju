const fs = require('fs');
const path = require('path');

const clearDirectories = () => {
    const directories = [
        path.resolve(__dirname, '../src/data/jingjiaqiangchou'),
        path.resolve(__dirname, '../src/data/kaipanzhudong'),
        path.resolve(__dirname, '../src/data/kaipanxiacuo')
    ];

    directories.forEach(dir => {
        if (fs.existsSync(dir)) {
            const files = fs.readdirSync(dir);
            files.forEach(file => {
                const filePath = path.join(dir, file);
                const stat = fs.statSync(filePath);
                if (stat.isFile()) {
                    fs.unlinkSync(filePath);
                } else if (stat.isDirectory()) {
                    fs.rmSync(filePath, { recursive: true, force: true });
                }
            });
            console.log(`已成功清理目录: ${dir}`);
        } else {
            console.warn(`目录不存在，跳过清理: ${dir}`);
        }
    });
};

clearDirectories();
