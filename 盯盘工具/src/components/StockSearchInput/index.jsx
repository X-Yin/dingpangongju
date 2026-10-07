import { useEffect, useRef, useState } from 'react';
import { Input, Spin } from 'antd';
import axios from 'axios';
import { local_ip } from '../../constant';
import './index.scss';

/**
 * 股票搜索输入框
 * 交互：输入名称（或代码）后按回车才发起搜索 → 下拉展示「名称 + 带 sh/sz 前缀的 code」
 *      → 再按一次回车（或点击某项）选中：名称回填到输入框，code 以小灰字展示在输入框下方
 * 受控组件：value 为名称，code 为已选中的代码；两者的变化都通过 onChange(name, code) 回调，
 *          输入过程中 code 一律回调为 ''（名称已变，旧 code 不再可信）
 */
const StockSearchInput = ({
    value = '',
    code = '',
    onChange,
    placeholder = '输入名称或代码，按回车搜索',
    autoFocus = false,
    disabled = false,
    style,
}) => {
    const [searchOptions, setSearchOptions] = useState([]); // 下拉选项 [{ code, name }]
    const [dropdownOpen, setDropdownOpen] = useState(false); // 下拉是否展开
    const [searching, setSearching] = useState(false); // 是否在搜索（仅用于输入框右侧转圈）
    const [activeIndex, setActiveIndex] = useState(-1); // 键盘高亮项
    // 以下判断都在键盘/鼠标回调里读取，必须拿到实时值，故用 ref 而不是 state
    const reqSeqRef = useRef(0); // 请求序号，丢弃过期响应
    const dropdownOpenRef = useRef(false);
    const optionsRef = useRef([]);
    const activeIndexRef = useRef(-1);
    const inFlightQueryRef = useRef(''); // 在途搜索的 query（'' 表示当前没有在途请求）
    const pickFirstOnResultRef = useRef(false); // 结果到达后是否自动选中第一项
    const fieldRef = useRef(null);

    // 空列表也展开：用于展示「无搜索结果」提示（此时无高亮项，回车会重新触发搜索）
    const openDropdown = (list) => {
        optionsRef.current = list;
        dropdownOpenRef.current = true;
        setSearchOptions(list);
        setDropdownOpen(true);
        activeIndexRef.current = list.length > 0 ? 0 : -1;
        setActiveIndex(list.length > 0 ? 0 : -1);
    };

    const closeDropdown = () => {
        optionsRef.current = [];
        dropdownOpenRef.current = false;
        activeIndexRef.current = -1;
        setSearchOptions([]);
        setDropdownOpen(false);
        setActiveIndex(-1);
    };

    const updateActiveIndex = (next) => {
        activeIndexRef.current = next;
        setActiveIndex(next);
    };

    // 下拉展开期间，点击外部区域时收起
    useEffect(() => {
        if (!dropdownOpen) return;
        const onDocMouseDown = (e) => {
            if (fieldRef.current && !fieldRef.current.contains(e.target)) {
                closeDropdown();
            }
        };
        document.addEventListener('mousedown', onDocMouseDown);
        return () => document.removeEventListener('mousedown', onDocMouseDown);
    }, [dropdownOpen]);

    // 名称被外部清空（如弹窗打开时重置表单）时，清掉残留的下拉与在途请求
    useEffect(() => {
        if (value) return;
        reqSeqRef.current += 1;
        inFlightQueryRef.current = '';
        pickFirstOnResultRef.current = false;
        optionsRef.current = [];
        dropdownOpenRef.current = false;
        activeIndexRef.current = -1;
        setSearchOptions([]);
        setDropdownOpen(false);
        setActiveIndex(-1);
        setSearching(false);
    }, [value]);

    const fetchSearchOptions = async (query) => {
        const seq = ++reqSeqRef.current;
        inFlightQueryRef.current = query;
        setSearching(true);
        try {
            const { data } = await axios.get(`http://${local_ip}:3000/search_stock`, { params: { query } });
            if (seq !== reqSeqRef.current) return; // 已过期（文字又被改过 / 发了新搜索），直接丢弃
            const list = (data && data.data) || [];
            // 结果到达前用户已经按过第二次回车：直接选中第一项回填，不让这次回车白按
            if (pickFirstOnResultRef.current) {
                pickFirstOnResultRef.current = false;
                if (list.length > 0) {
                    handleSelectOption(list[0]);
                    return;
                }
            }
            openDropdown(list);
        } catch (error) {
            console.error('搜索股票失败:', error);
            pickFirstOnResultRef.current = false;
            if (seq === reqSeqRef.current) closeDropdown();
        } finally {
            if (inFlightQueryRef.current === query) {
                inFlightQueryRef.current = '';
                setSearching(false);
            }
        }
    };

    // 输入阶段只同步值、作废旧 code，并清掉上一次搜索的残留结果
    const handleInputChange = (e) => {
        reqSeqRef.current += 1; // 文字已变，在途请求的结果作废，避免旧结果把下拉弹出来
        pickFirstOnResultRef.current = false;
        if (inFlightQueryRef.current) {
            inFlightQueryRef.current = '';
            setSearching(false);
        }
        closeDropdown();
        onChange?.(e.target.value, '');
    };

    // 选中某项：先收起下拉再通知外部，保证无论外部如何处理，下拉都会消失
    // 在 onMouseDown 阶段就完成选中，避免下拉先被收起导致 click 丢失
    const handleSelectOption = (item) => {
        closeDropdown();
        pickFirstOnResultRef.current = false;
        onChange?.(item.name, item.code);
    };

    // 回车：下拉已展开则选中高亮项（默认第一项）；否则触发搜索
    // 上下键切换高亮，Esc 收起
    const handleKeyDown = (e) => {
        // 输入法拼字中，回车属于输入法（确认候选词），不触发搜索
        if (e.nativeEvent.isComposing) return;
        if (e.key === 'Enter') {
            e.preventDefault();
            const options = optionsRef.current;
            if (dropdownOpenRef.current && options.length) {
                handleSelectOption(options[activeIndexRef.current >= 0 ? activeIndexRef.current : 0]);
                return;
            }
            const query = value.trim();
            if (!query) return;
            if (inFlightQueryRef.current === query) {
                // 同一段文字的搜索还在途：挂起这次回车，结果到达后自动选中第一项
                pickFirstOnResultRef.current = true;
                return;
            }
            fetchSearchOptions(query);
            return;
        }
        if (e.key === 'Escape') {
            // 「无搜索结果」的空下拉也要能被 Esc 收起
            if (dropdownOpenRef.current) closeDropdown();
            return;
        }
        if (!dropdownOpenRef.current || !optionsRef.current.length) return;
        const total = optionsRef.current.length;
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            updateActiveIndex((activeIndexRef.current + 1) % total);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            updateActiveIndex((activeIndexRef.current - 1 + total) % total);
        }
    };

    return (
        <div className="stock-search-input" ref={fieldRef} style={style}>
            <Input
                value={value}
                placeholder={placeholder}
                disabled={disabled}
                autoFocus={autoFocus}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                onFocus={() => { if (optionsRef.current.length) openDropdown(optionsRef.current); }}
                // suffix 必须始终为真值：否则 antd 会在「无 affix 包装」与「有 affix 包装」之间切换渲染，
                // 导致 <input> DOM 节点被销毁重建、输入框丢失焦点（后续回车全部落到 body 上而失效）
                suffix={searching ? <Spin size="small" /> : <span />}
            />
            {code ? <div className="stock-search-input-code">{code}</div> : null}
            {dropdownOpen ? (
                searchOptions.length > 0 ? (
                    <div className="stock-search-input-dropdown">
                        {searchOptions.map((item, idx) => (
                            <div
                                key={`${item.code}-${idx}`}
                                className={`stock-search-input-option${idx === activeIndex ? ' active' : ''}`}
                                onMouseDown={(e) => {
                                    e.preventDefault(); // 防止输入框失焦导致下拉先收起
                                    handleSelectOption(item);
                                }}
                                onMouseEnter={() => updateActiveIndex(idx)}
                                onClick={() => handleSelectOption(item)}
                            >
                                <span className="stock-search-input-option-name">{item.name}</span>
                                <span className="stock-search-input-option-code">{item.code}</span>
                            </div>
                        ))}
                    </div>
                ) : (
                    <div className="stock-search-input-dropdown">
                        <div className="stock-search-input-empty">无搜索结果</div>
                    </div>
                )
            ) : null}
        </div>
    );
};

export default StockSearchInput;