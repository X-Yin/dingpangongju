import React, { useState, useEffect } from 'react';
import { Row, Col, message } from 'antd';
import axios from 'axios';
import { local_ip } from '../../../constant';
import PersonalSuggestionEditor from '../components/PersonalSuggestionEditor';

const SuggestionModule = () => {
  const [globalSuggData, setGlobalSuggData] = useState('');
  const [tempSuggData, setTempSuggData] = useState('');

  const fetchData = async () => {
    try {
      const response = await axios.get(`http://${local_ip}:3000/get_main_problem`);
      if (response.data) {
        setGlobalSuggData(response.data.personalSuggData?.globalSuggContent || '');
        setTempSuggData(response.data.personalSuggData?.tempSuggContent || '');
      }
    } catch (error) {
      console.error('Error fetching data:', error);
      message.error('获取数据失败');
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const handleUpdatePersonalSuggestion = async (type, content) => {
    try {
      const payload = {};
      if (type === 'globalSuggData') {
        payload.globalSuggContent = content;
      } else if (type === 'tempSuggData') {
        payload.tempSuggContent = content;
      }
      await axios.post(`http://${local_ip}:3000/update_personal_sugg`, payload);
      message.success(`${type === 'globalSuggData' ? '全局市场观点' : '短期操作观点'}更新成功`);
      if (type === 'globalSuggData') {
        setGlobalSuggData(content);
      } else if (type === 'tempSuggData') {
        setTempSuggData(content);
      }
    } catch (error) {
      console.error('Error updating personal suggestion:', error);
      message.error('更新个人观点失败');
    }
  };

  return (
    <div>
      <Row gutter={[16, 16]}>
        <Col span={12}>
          <PersonalSuggestionEditor
            title="全局市场观点"
            initialContent={globalSuggData}
            onSave={(content) => handleUpdatePersonalSuggestion('globalSuggData', content)}
            cacheId="global-sugg-vditor-cache"
          />
        </Col>
        <Col span={12}>
          <PersonalSuggestionEditor
            title="短期操作观点"
            initialContent={tempSuggData}
            onSave={(content) => handleUpdatePersonalSuggestion('tempSuggData', content)}
            cacheId="temp-sugg-vditor-cache"
          />
        </Col>
      </Row>
    </div>
  );
};

export default SuggestionModule;
