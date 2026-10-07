// Vditor 运行时会根据 cdn 配置拼接 /dist/js/lute/lute.min.js、/dist/js/highlight.js、
// /dist/js/icons、/dist/css/content-theme 等路径加载资源。
// 默认走 unpkg 线上 CDN，国内加载很慢，这里统一指向本地 public/vditor 目录
// （内容由 node_modules/vditor/dist 的 js/css/images 拷贝而来，升级 vditor 后需重新拷贝）。
export const VDITOR_CDN = '/vditor';
