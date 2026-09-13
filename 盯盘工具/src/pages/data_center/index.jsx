import { useState, useEffect, useMemo, useCallback } from 'react';
import { Tabs, Tree, Spin, message, Button, Input, Radio, Space, Card, Empty, Tag, InputNumber, Modal, Checkbox } from 'antd';
import { DatabaseOutlined, StockOutlined, CopyOutlined, SearchOutlined, FileTextOutlined, ReloadOutlined, CheckCircleOutlined, EditOutlined, FolderOutlined, EyeInvisibleOutlined, EyeOutlined } from '@ant-design/icons';
import axios from 'axios';
import { local_ip } from '../../constant';
import { getThemeColor } from '../../utils/theme';
import './index.scss';

const BASE_URL = `http://${local_ip}:3000`;

// 从路径生成默认 key（不含扩展名）
const pathToDefaultKey = (p) => {
  const parts = p.split('/');
  return parts[parts.length - 1].replace(/\.json$/, '');
};

// 三大指数
const INDEX_OPTIONS = [
  { code: 'sh000001', name: '上证指数' },
  { code: 'sz399006', name: '创业板指' },
  { code: 'sh000688', name: '科创50' },
];

// 格式化文件大小
const formatSize = (bytes) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
};

// 复制文本到剪贴板（带降级方案）
const copyToClipboard = async (text) => {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) {
    // 降级到 execCommand
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch (e) {
    return false;
  }
};

// ========== 数据文件 Tab ==========
const DataFilesTab = () => {
  const [tree, setTree] = useState([]);
  const [loading, setLoading] = useState(false);
  const [checkedKeys, setCheckedKeys] = useState([]);
  const [previewContent, setPreviewContent] = useState(null);
  const [previewPath, setPreviewPath] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [searchKeyword, setSearchKeyword] = useState('');
  const [copying, setCopying] = useState(false);
  // 别名映射 { path: alias }
  const [aliases, setAliases] = useState({});
  // 隐藏路径列表
  const [hiddenPaths, setHiddenPaths] = useState([]);
  // 是否显示全部（含隐藏项）
  const [showAll, setShowAll] = useState(false);
  // 重命名弹窗
  const [renameState, setRenameState] = useState({ visible: false, path: '', original: '', value: '' });

  const fetchFiles = useCallback(() => {
    setLoading(true);
    axios.get(`${BASE_URL}/data_center/files`)
      .then(res => {
        if (res.data?.success) setTree(res.data.data);
      })
      .catch(err => message.error('获取文件列表失败: ' + (err.response?.data?.message || err.message)))
      .finally(() => setLoading(false));
  }, []);

  // 从后端加载别名
  const fetchAliases = useCallback(() => {
    axios.get(`${BASE_URL}/data_center/aliases`)
      .then(res => {
        if (res.data?.success) setAliases(res.data.data || {});
      })
      .catch(() => { /* ignore */ });
  }, []);

  // 从后端加载隐藏路径
  const fetchHidden = useCallback(() => {
    axios.get(`${BASE_URL}/data_center/hidden`)
      .then(res => {
        if (res.data?.success) setHiddenPaths(res.data.data || []);
      })
      .catch(() => { /* ignore */ });
  }, []);

  useEffect(() => { fetchFiles(); fetchAliases(); fetchHidden(); }, [fetchFiles, fetchAliases, fetchHidden]);

  // 切换隐藏/显示
  const handleToggleHidden = async (filePath, hide) => {
    try {
      const res = await axios.post(`${BASE_URL}/data_center/hidden`, { path: filePath, hidden: hide });
      if (res.data?.success) {
        setHiddenPaths(res.data.data || []);
      }
    } catch (err) {
      message.error('操作失败: ' + (err.response?.data?.message || err.message));
    }
  };

  // 构造 AntD Tree 数据，同时收集所有文件 key
  const { treeData, allFileKeys } = useMemo(() => {
    const fileKeys = [];
    const hiddenSet = new Set(hiddenPaths);

    const buildTitle = (node) => {
      const hasAlias = !!aliases[node.path];
      const displayName = hasAlias ? aliases[node.path] : node.name.replace(/\.json$/, '');
      const matched = !searchKeyword || node.path.toLowerCase().includes(searchKeyword.toLowerCase()) ||
        displayName.toLowerCase().includes(searchKeyword.toLowerCase());
      const isDir = node.type === 'directory';
      const isHidden = hiddenSet.has(node.path);
      return (
        <span className={`dc-file-item${matched ? '' : ' dc-file-item-dim'}${isHidden ? ' dc-file-item-hidden' : ''}`}>
          {isDir
            ? <FolderOutlined style={{ marginRight: 4, color: '#faad14' }} />
            : <FileTextOutlined style={{ marginRight: 4, color: getThemeColor() }} />
          }
          <span className="dc-file-name">{displayName}</span>
          {hasAlias && <span className="dc-file-alias-badge">别名</span>}
          {isHidden && <span className="dc-hidden-badge">已隐藏</span>}
          {!isDir && <span className="dc-file-size">{formatSize(node.size)}</span>}
          <EditOutlined
            className="dc-rename-btn"
            onClick={(e) => {
              e.stopPropagation();
              setRenameState({
                visible: true,
                path: node.path,
                original: node.name.replace(/\.json$/, ''),
                value: aliases[node.path] || node.name.replace(/\.json$/, ''),
              });
            }}
          />
          {isHidden ? (
            <EyeOutlined
              className="dc-rename-btn"
              title="取消隐藏"
              onClick={(e) => { e.stopPropagation(); handleToggleHidden(node.path, false); }}
            />
          ) : (
            <EyeInvisibleOutlined
              className="dc-rename-btn"
              title="隐藏"
              onClick={(e) => { e.stopPropagation(); handleToggleHidden(node.path, true); }}
            />
          )}
        </span>
      );
    };

    const build = (nodes) => {
      const result = [];
      for (const node of nodes) {
        const isHidden = hiddenSet.has(node.path);
        // 不显示全部时，跳过隐藏项
        if (!showAll && isHidden) continue;

        if (node.type === 'directory') {
          const children = build(node.children || []);
          // 不显示全部时，跳过空目录（所有子项都隐藏了）
          if (!showAll && children.length === 0) continue;
          result.push({
            key: node.path,
            title: buildTitle(node),
            selectable: false,
            children,
          });
        } else {
          fileKeys.push(node.path);
          result.push({
            key: node.path,
            title: buildTitle(node),
            isLeaf: true,
            path: node.path,
          });
        }
      }
      return result;
    };
    return { treeData: build(tree), allFileKeys: fileKeys };
  }, [tree, searchKeyword, aliases, hiddenPaths, showAll]);

  const checkedFileKeys = useMemo(
    () => checkedKeys.filter(k => allFileKeys.includes(k)),
    [checkedKeys, allFileKeys]
  );

  // 保存别名（调用后端 API）
  const handleRenameSave = async () => {
    const { path: filePath, value, original } = renameState;
    const trimmed = value.trim();
    const aliasToSave = (trimmed && trimmed !== original) ? trimmed : '';
    try {
      const res = await axios.post(`${BASE_URL}/data_center/alias`, { path: filePath, alias: aliasToSave });
      if (res.data?.success) {
        setAliases(res.data.data || {});
        message.success(aliasToSave ? '已设置别名' : '已重置为原名');
      } else {
        message.error(res.data?.message || '保存失败');
      }
    } catch (err) {
      message.error('保存别名失败: ' + (err.response?.data?.message || err.message));
    }
    setRenameState({ visible: false, path: '', original: '', value: '' });
  };

  const handlePreview = async (path) => {
    setPreviewLoading(true);
    setPreviewPath(path);
    try {
      const res = await axios.get(`${BASE_URL}/data_center/file`, { params: { path } });
      if (res.data?.success) {
        setPreviewContent(res.data.data);
      } else {
        message.error(res.data?.message || '读取失败');
      }
    } catch (err) {
      message.error('读取文件失败: ' + (err.response?.data?.message || err.message));
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleCopy = async () => {
    if (checkedFileKeys.length === 0) {
      message.warning('请先选择要复制的文件');
      return;
    }
    setCopying(true);
    try {
      const res = await axios.post(`${BASE_URL}/data_center/batch_files`, { paths: checkedFileKeys });
      if (res.data?.success) {
        // 后端返回 { path: content }，前端用别名重映射 key
        const remapped = {};
        const usedKeys = new Set();
        for (const [path, content] of Object.entries(res.data.data)) {
          let key = aliases[path] || pathToDefaultKey(path);
          // 处理重名
          if (usedKeys.has(key)) {
            const dirPart = path.includes('/') ? path.split('/')[0] : '';
            key = dirPart ? `${dirPart}_${key}` : `${key}_${Date.now()}`;
          }
          usedKeys.add(key);
          remapped[key] = content;
        }
        const text = JSON.stringify(remapped, null, 2);
        const ok = await copyToClipboard(text);
        if (ok) {
          message.success(`已复制 ${checkedFileKeys.length} 个文件内容到剪贴板`);
        } else {
          message.error('复制失败，请手动复制');
        }
      } else {
        message.error(res.data?.message || '读取失败');
      }
    } catch (err) {
      message.error('复制失败: ' + (err.response?.data?.message || err.message));
    } finally {
      setCopying(false);
    }
  };

  return (
    <div className="dc-data-files">
      <div className="dc-toolbar">
        <Input
          placeholder="搜索文件名/别名..."
          prefix={<SearchOutlined />}
          value={searchKeyword}
          onChange={e => setSearchKeyword(e.target.value)}
          allowClear
          style={{ width: 240 }}
        />
        <Button icon={<ReloadOutlined />} onClick={fetchFiles}>刷新</Button>
        <Checkbox checked={showAll} onChange={e => setShowAll(e.target.checked)}>显示全部</Checkbox>
        <span className="dc-selected-info">
          已选 <strong style={{ color: getThemeColor() }}>{checkedFileKeys.length}</strong> 个文件
        </span>
        <Button
          type="primary"
          icon={<CopyOutlined />}
          onClick={handleCopy}
          loading={copying}
          disabled={checkedFileKeys.length === 0}
        >
          复制选中文件内容
        </Button>
        {checkedFileKeys.length > 0 && (
          <Button type="link" onClick={() => setCheckedKeys([])}>清空选择</Button>
        )}
      </div>

      <div className="dc-files-body">
        <div className="dc-files-tree">
          <Spin spinning={loading}>
            {treeData.length > 0 ? (
              <Tree
                checkable
                checkedKeys={checkedKeys}
                onCheck={(keys) => setCheckedKeys(keys)}
                treeData={treeData}
                defaultExpandAll={searchKeyword.length > 0}
                showLine
                onSelect={(keys, info) => {
                  if (info.node?.isLeaf && keys[0]) {
                    handlePreview(keys[0]);
                  }
                }}
              />
            ) : (
              <Empty description="暂无数据文件" />
            )}
          </Spin>
        </div>

        <div className="dc-files-preview">
          <div className="dc-preview-header">
            <span className="dc-preview-title">
              {previewPath
                ? `预览: ${aliases[previewPath] || previewPath}`
                : '点击文件名预览内容'}
            </span>
            {previewContent !== null && (
              <Button
                size="small"
                icon={<CopyOutlined />}
                onClick={async () => {
                  const key = aliases[previewPath] || pathToDefaultKey(previewPath);
                  const text = JSON.stringify({ [key]: previewContent }, null, 2);
                  const ok = await copyToClipboard(text);
                  if (ok) message.success('已复制到剪贴板');
                  else message.error('复制失败');
                }}
              >
                复制
              </Button>
            )}
          </div>
          <Spin spinning={previewLoading} style={{ overflowY: 'auto' }}>
            <pre className="dc-preview-content">
              {previewContent !== null
                ? JSON.stringify(previewContent, null, 2)
                : '// 选择左侧文件查看内容'}
            </pre>
          </Spin>
        </div>
      </div>

      {/* 重命名弹窗 */}
      <Modal
        title="设置别名"
        open={renameState.visible}
        onOk={handleRenameSave}
        onCancel={() => setRenameState({ visible: false, path: '', original: '', value: '' })}
        okText="保存"
        cancelText="取消"
        width={420}
        destroyOnClose
      >
        <div style={{ marginBottom: 8, fontSize: 13, color: '#8c8c8c' }}>
          原名: <strong>{renameState.original}</strong>
        </div>
        <Input
          value={renameState.value}
          onChange={e => setRenameState(prev => ({ ...prev, value: e.target.value }))}
          placeholder="输入别名（留空则重置为原名）"
          onPressEnter={handleRenameSave}
          autoFocus
        />
        <div style={{ marginTop: 8, fontSize: 12, color: '#bfbfbf' }}>
          别名仅用于前端展示和复制时的 JSON key，不会修改后端文件名
        </div>
      </Modal>
    </div>
  );
};

// ========== 自选股数据 Tab ==========
const StocksDataTab = () => {
  const [stocks, setStocks] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selectedCodes, setSelectedCodes] = useState([]);
  const [dataType, setDataType] = useState('kline'); // kline | tline
  const [klineLimit, setKlineLimit] = useState(100);
  const [copying, setCopying] = useState(false);
  const [searchKeyword, setSearchKeyword] = useState('');

  const fetchStocks = useCallback(() => {
    setLoading(true);
    axios.get(`${BASE_URL}/get_all_stock_data`)
      .then(res => {
        const data = Array.isArray(res.data) ? res.data : [];
        setStocks(data);
      })
      .catch(err => message.error('获取自选股列表失败: ' + (err.response?.data?.message || err.message)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { fetchStocks(); }, [fetchStocks]);

  const filteredStocks = useMemo(() => {
    if (!searchKeyword) return stocks;
    const kw = searchKeyword.toLowerCase();
    return stocks.filter(s =>
      (s.code || '').toLowerCase().includes(kw) ||
      (s.stockName || s.name || '').toLowerCase().includes(kw)
    );
  }, [stocks, searchKeyword]);

  const handleCopy = async () => {
    if (selectedCodes.length === 0) {
      message.warning('请先选择股票');
      return;
    }
    setCopying(true);
    try {
      const endpoint = dataType === 'kline' ? '/data_center/stocks_kline' : '/data_center/stocks_tline';
      const body = dataType === 'kline'
        ? { codes: selectedCodes, limit: klineLimit }
        : { codes: selectedCodes };
      const res = await axios.post(`${BASE_URL}${endpoint}`, body);
      if (res.data?.success) {
        const text = JSON.stringify(res.data.data, null, 2);
        const ok = await copyToClipboard(text);
        if (ok) {
          message.success(`已复制 ${selectedCodes.length} 只股票的${dataType === 'kline' ? '日K' : '分时'}数据到剪贴板`);
        } else {
          message.error('复制失败，请手动复制');
        }
      } else {
        message.error(res.data?.message || '获取失败');
      }
    } catch (err) {
      message.error('复制失败: ' + (err.response?.data?.message || err.message));
    } finally {
      setCopying(false);
    }
  };

  return (
    <div className="dc-stocks-data">
      <div className="dc-toolbar">
        <Input
          placeholder="搜索股票名称/代码..."
          prefix={<SearchOutlined />}
          value={searchKeyword}
          onChange={e => setSearchKeyword(e.target.value)}
          allowClear
          style={{ width: 240 }}
        />
        <Button icon={<ReloadOutlined />} onClick={fetchStocks}>刷新</Button>
        <span className="dc-selected-info">
          共 <strong>{stocks.length}</strong> 只，已选 <strong style={{ color: getThemeColor() }}>{selectedCodes.length}</strong> 只
        </span>
      </div>

      <div className="dc-options-bar">
        <Space>
          <span>数据类型:</span>
          <Radio.Group value={dataType} onChange={e => setDataType(e.target.value)}>
            <Radio.Button value="kline">日K数据</Radio.Button>
            <Radio.Button value="tline">分时数据</Radio.Button>
          </Radio.Group>
        </Space>
        {dataType === 'kline' && (
          <Space>
            <span>K线条数:</span>
            <InputNumber
              min={1}
              max={500}
              value={klineLimit}
              onChange={v => setKlineLimit(v || 100)}
              style={{ width: 100 }}
            />
          </Space>
        )}
        <Button
          type="primary"
          icon={<CopyOutlined />}
          onClick={handleCopy}
          loading={copying}
          disabled={selectedCodes.length === 0}
        >
          复制选中股票数据
        </Button>
        {selectedCodes.length > 0 && (
          <Button type="link" onClick={() => setSelectedCodes([])}>清空选择</Button>
        )}
      </div>

      <div className="dc-stocks-list">
        <Spin spinning={loading}>
          <div className="dc-stocks-grid">
            {filteredStocks.map(stock => {
              const isSelected = selectedCodes.includes(stock.code);
              return (
                <div
                  key={stock.code}
                  className={`dc-stock-chip${isSelected ? ' dc-stock-chip-selected' : ''}`}
                  onClick={() => {
                    setSelectedCodes(prev =>
                      prev.includes(stock.code)
                        ? prev.filter(c => c !== stock.code)
                        : [...prev, stock.code]
                    );
                  }}
                >
                  <span className="dc-stock-chip-name">{stock.stockName || stock.name}</span>
                  <span className="dc-stock-chip-code">{stock.code}</span>
                  {stock.change !== undefined && (
                    <span
                      className="dc-stock-chip-change"
                      style={{ color: parseFloat(stock.change) >= 0 ? '#f5222d' : '#52c41a' }}
                    >
                      {parseFloat(stock.change) >= 0 ? '+' : ''}{parseFloat(stock.change).toFixed(2)}%
                    </span>
                  )}
                  {isSelected && <CheckCircleOutlined className="dc-stock-chip-check" />}
                </div>
              );
            })}
          </div>
          {filteredStocks.length === 0 && !loading && <Empty description="暂无匹配股票" />}
        </Spin>
      </div>
    </div>
  );
};

// ========== 指数数据 Tab ==========
const IndexesDataTab = () => {
  const [selectedIndexes, setSelectedIndexes] = useState(INDEX_OPTIONS.map(i => i.code));
  const [dataType, setDataType] = useState('kline'); // kline | tline
  const [klineLimit, setKlineLimit] = useState(100);
  const [copying, setCopying] = useState(false);

  const handleCopy = async () => {
    if (selectedIndexes.length === 0) {
      message.warning('请先选择指数');
      return;
    }
    setCopying(true);
    try {
      const endpoint = dataType === 'kline' ? '/data_center/indexes_kline' : '/data_center/indexes_tline';
      const body = dataType === 'kline'
        ? { codes: selectedIndexes, limit: klineLimit }
        : { codes: selectedIndexes };
      const res = await axios.post(`${BASE_URL}${endpoint}`, body);
      if (res.data?.success) {
        const text = JSON.stringify(res.data.data, null, 2);
        const ok = await copyToClipboard(text);
        if (ok) {
          message.success(`已复制 ${selectedIndexes.length} 个指数的${dataType === 'kline' ? '日K' : '分时'}数据到剪贴板`);
        } else {
          message.error('复制失败，请手动复制');
        }
      } else {
        message.error(res.data?.message || '获取失败');
      }
    } catch (err) {
      message.error('复制失败: ' + (err.response?.data?.message || err.message));
    } finally {
      setCopying(false);
    }
  };

  return (
    <div className="dc-indexes-data">
      <div className="dc-options-bar">
        <Space>
          <span>选择指数:</span>
          {INDEX_OPTIONS.map(idx => {
            const checked = selectedIndexes.includes(idx.code);
            return (
              <Tag.CheckableTag
                key={idx.code}
                checked={checked}
                onChange={checked => {
                  setSelectedIndexes(prev =>
                    checked
                      ? [...prev, idx.code]
                      : prev.filter(c => c !== idx.code)
                  );
                }}
                className="dc-index-tag"
              >
                {idx.name} ({idx.code})
              </Tag.CheckableTag>
            );
          })}
        </Space>
      </div>

      <div className="dc-options-bar">
        <Space>
          <span>数据类型:</span>
          <Radio.Group value={dataType} onChange={e => setDataType(e.target.value)}>
            <Radio.Button value="kline">日K数据</Radio.Button>
            <Radio.Button value="tline">分时数据</Radio.Button>
          </Radio.Group>
        </Space>
        {dataType === 'kline' && (
          <Space>
            <span>K线条数:</span>
            <InputNumber
              min={1}
              max={500}
              value={klineLimit}
              onChange={v => setKlineLimit(v || 100)}
              style={{ width: 100 }}
            />
          </Space>
        )}
        <Button
          type="primary"
          icon={<CopyOutlined />}
          onClick={handleCopy}
          loading={copying}
          disabled={selectedIndexes.length === 0}
        >
          复制指数数据
        </Button>
      </div>

      <Card className="dc-indexes-tips" size="small">
        <p>· <strong>日K数据</strong>：从同花顺/财联社拉取最近 N 天的日K线数据（含 OHLCV、涨跌幅、MA5/MA10/MA20）</p>
        <p>· <strong>分时数据</strong>：获取当日分时走势数据（含分时价格、成交量、涨跌幅）</p>
        <p>· <strong>三大指数</strong>：上证指数 (sh000001)、创业板指 (sz399006)、科创50 (sh000688)</p>
        <p>· 复制后可直接粘贴到 JSON 文件或 AI 对话中使用</p>
      </Card>
    </div>
  );
};

// ========== 主组件 ==========
const DataCenter = ({ hideHeader = false }) => {
  const items = [
    {
      key: 'files',
      label: (
        <span><DatabaseOutlined /> 数据文件</span>
      ),
      children: <DataFilesTab />,
    },
    {
      key: 'stocks',
      label: (
        <span><StockOutlined /> 自选股数据</span>
      ),
      children: <StocksDataTab />,
    },
    {
      key: 'indexes',
      label: (
        <span><StockOutlined /> 指数数据</span>
      ),
      children: <IndexesDataTab />,
    },
  ];

  return (
    <div className="data-center-container">
      {!hideHeader && (
        <div className="dc-header">
          <h2 className="dc-title">
            <DatabaseOutlined style={{ color: getThemeColor(), marginRight: 8 }} />
            数据中心
          </h2>
          <p className="dc-subtitle">复制后端数据文件、自选股K线/分时数据、指数K线/分时数据，可直接粘贴到 AI 对话中使用</p>
        </div>
      )}
      <Tabs
        defaultActiveKey="files"
        items={items}
        className="dc-tabs"
        size="large"
      />
    </div>
  );
};

export default DataCenter;
