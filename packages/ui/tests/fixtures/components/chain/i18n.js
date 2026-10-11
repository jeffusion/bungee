import { writable } from 'svelte/store';
    const translate = key => ({ 'logs.requestType_retry': '重试', 'logs.requestType_final': '最终请求',
      'logs.transport.completed': '已完成', 'logs.transport.failed': '传输失败', 'logs.transport.cancelled': '已取消',
      'logs.chain.timelineTitle': '尝试时间线', 'logs.chain.detailTitle': '请求链详情',
      'logs.chain.overview': '请求链概览' }[key] || '测试字段');
    export const _ = writable(translate);
    window.refreshTranslation = () => _.set(key => translate(key));