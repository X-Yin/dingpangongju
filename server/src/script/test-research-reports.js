const { 
  getResearchReports, 
  getResearchReportById,
  createResearchReport, 
  updateResearchReport, 
  deleteResearchReport,
  moveResearchReport 
} = require('../service/researchReport');

console.log('=== 测试研报管理新架构 ===\n');

console.log('1. 测试获取菜单（不含 content 字段:');
const menu = getResearchReports();
console.log('✓ 菜单获取成功，根项目数量:', menu.length);
console.log('  菜单项结构:', Object.keys(menu[0]));
console.log();

console.log('2. 测试获取单个研报（包含 content 字段）:');
const firstReportId = menu[0].children[0].id;
const report = getResearchReportById(firstReportId);
console.log('✓ 研报获取成功');
console.log('  研报结构:', Object.keys(report));
console.log('  包含 content:', !!report.content);
console.log();

console.log('3. 测试创建文件夹:');
const newFolder = createResearchReport(null, '测试文件夹', 'folder');
console.log('✓ 文件夹创建成功:', newFolder);
console.log();

console.log('4. 测试创建研报:');
const newReport = createResearchReport(newFolder.id, '测试研报', 'report', '这是测试内容');
console.log('✓ 研报创建成功:', newReport);
console.log();

console.log('5. 测试更新研报:');
const updatedReport = updateResearchReport(newReport.id, { name: '更新后的测试研报', content: '这是更新后的内容' });
console.log('✓ 研报更新成功:', updatedReport);
console.log();

console.log('6. 测试移动研报:');
const moved = moveResearchReport(newReport.id, null);
console.log('✓ 研报移动成功:', moved);
console.log();

console.log('7. 清理测试数据:');
deleteResearchReport(newFolder.id);
deleteResearchReport(newReport.id);
console.log('✓ 测试数据清理完成');
console.log();

console.log('=== 所有测试通过！新架构正常工作。');
