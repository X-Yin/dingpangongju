const fs = require('fs');
const path = require('path');

// 删除 src/data/kaipanzhudong 和 src/data/jingjiaqiangchou 目录下的所有文件
const clearDirectories = () => {
    const directories = [
        path.resolve(__dirname, '../src/data/kaipanzhudong'),
        path.resolve(__dirname, '../src/data/jingjiaqiangchou')
    ];

    directories.forEach(dir => {
        if (fs.existsSync(dir)) {
            const files = fs.readdirSync(dir);
            files.forEach(file => {
                const filePath = path.join(dir, file);
                // 确保只删除文件而非目录（如果需要递归删除目录可使用 fs.rmSync）
                if (fs.statSync(filePath).isFile()) {
                    fs.unlinkSync(filePath);
                }
            });
            console.log(`已成功清理目录: ${dir}`);
        } else {
            console.warn(`目录不存在，跳过清理: ${dir}`);
        }
    });

    // 清空 amount.json 文件
    fs.writeFileSync(path.resolve(__dirname, '../src/data/amount.json'), '[]');

    // 清空 jisuyidong.json 文件
    fs.writeFileSync(path.resolve(__dirname, '../src/data/jisuyidong.json'), '{}');
};

clearDirectories();
