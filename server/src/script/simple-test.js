const { getResearchReports, getResearchReportById } = require('../service/researchReport');

console.log('=== 简单功能测试 ===\n');

console.log('1. 测试获取菜单:');
const menu = getResearchReports();
console.log('✓ 成功，根项目数:', menu.length);
console.log('   根项目类型:', menu[0].type);
console.log('   根项目名称:', menu[0].name);
console.log('   根项目字段:', Object.keys(menu[0]));
console.log();

console.log('2. 测试获取第一个研报:');
const firstReport = menu[0].children[0];
const fullReport = getResearchReportById(firstReport.id);
console.log('✓ 成功');
console.log('   研报名称:', fullReport.name);
console.log('   包含content:', 'content' in fullReport);
console.log('   content长度:', fullReport.content ? fullReport.content.length : 0);
console.log();

console.log('✓ 简单功能测试通过！');
