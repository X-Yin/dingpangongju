
const axios = require('axios');

async function testAPI() {
  console.log('=== 验证后端 API 行为 ===\n');
  
  try {
    // 1. 测试获取菜单（应该不含 content）
    console.log('1. 测试 /get_research_reports 接口:');
    const menuResponse = await axios.get('http://localhost:3000/get_research_reports');
    const menuData = menuResponse.data;
    console.log('   ✓ 响应成功');
    console.log('   根项目数量:', menuData.length);
    
    // 检查菜单项是否有 content
    let hasContentInMenu = false;
    const checkContent = (items) => {
      for (const item of items) {
        if (item.content) {
          hasContentInMenu = true;
          console.log('   ✗ 发现菜单项包含 content:', item.name);
        }
        if (item.children) {
          checkContent(item.children);
        }
      }
    };
    checkContent(menuData);
    
    if (!hasContentInMenu) {
      console.log('   ✓ 菜单不含 content，符合要求');
    }
    console.log();
    
    // 2. 测试获取单个研报（应该包含 content）
    const firstReport = menuData[0]?.children?.[0];
    if (firstReport?.type === 'report') {
      console.log('2. 测试 /get_research_report 接口:');
      const reportResponse = await axios.get('http://localhost:3000/get_research_report', {
        params: { id: firstReport.id }
      });
      const reportData = reportResponse.data;
      console.log('   ✓ 响应成功');
      console.log('   研报名称:', reportData.name);
      console.log('   包含 content:', !!reportData.content);
      if (reportData.content) {
        console.log('   ✓ 研报包含完整内容');
      }
    }
    
    console.log('\n=== 验证完成 ===');
    
  } catch (error) {
    console.error('错误:', error.message);
    console.log('请先启动后端服务: cd server && node src/index.js');
  }
}

testAPI();
