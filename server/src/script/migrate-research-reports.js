const fs = require('fs');
const path = require('path');

const OLD_DATA_FILE = path.resolve(__dirname, '../data/research_reports.json');
const NEW_DIR = path.resolve(__dirname, '../data/research_reports');
const NEW_MENU_FILE = path.resolve(NEW_DIR, 'menu.json');

const ensureNewDir = () => {
  if (!fs.existsSync(NEW_DIR)) {
    fs.mkdirSync(NEW_DIR, { recursive: true });
  }
};

const migrateReports = (items, menuItems) => {
  for (const item of items) {
    const menuItem = {
      id: item.id,
      name: item.name,
      type: item.type,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt
    };

    if (item.type === 'report') {
      const contentPath = path.resolve(NEW_DIR, `${item.id}.json`);
      fs.writeFileSync(contentPath, JSON.stringify({ content: item.content || '' }, null, 2), 'utf-8');
      menuItems.push(menuItem);
    } else if (item.type === 'folder') {
      menuItem.children = [];
      if (item.children) {
        migrateReports(item.children, menuItem.children);
      }
      menuItems.push(menuItem);
    }
  }
};

const runMigration = () => {
  console.log('开始迁移研报数据...');
  
  if (!fs.existsSync(OLD_DATA_FILE)) {
    console.log('未找到旧数据文件，无需迁移');
    return;
  }

  ensureNewDir();

  const oldData = JSON.parse(fs.readFileSync(OLD_DATA_FILE, 'utf-8'));
  const newMenu = [];

  migrateReports(oldData, newMenu);

  fs.writeFileSync(NEW_MENU_FILE, JSON.stringify(newMenu, null, 2), 'utf-8');

  console.log(`迁移完成！共处理 ${newMenu.length} 个根项目`);
  console.log(`新菜单文件: ${NEW_MENU_FILE}`);
  console.log(`研报内容保存在: ${NEW_DIR}`);
  console.log('旧数据文件已保留，确认新系统正常后可手动删除');
};

runMigration();
