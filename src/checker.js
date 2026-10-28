/**
 * 微信兼容性检查器。
 * 目的是在本地就把编辑器会清洗掉的东西拦下来，避免「本地好看、发出去变样」。
 */
const CHECKS = [
  { issue: '包含 <style> 标签（微信会剥离）', test: (h) => /<style\b/i.test(h) },
  { issue: '包含 <script> 标签', test: (h) => /<script\b/i.test(h) },
  { issue: '包含 <iframe> 标签', test: (h) => /<iframe\b/i.test(h) },
  { issue: '包含 <link> 标签', test: (h) => /<link\b/i.test(h) },
  { issue: '包含 class 属性（微信会剥离）', test: (h) => /\sclass\s*=/i.test(h) },
  {
    issue: '包含非法 id 属性（只允许 section#nice）',
    test: (h) => [...h.matchAll(/\sid="([^"]*)"/g)].some((m) => m[1] !== 'nice'),
  },
  { issue: '包含 flex / grid 布局', test: (h) => /display\s*:\s*(inline-)?(flex|grid)/i.test(h) },
  { issue: '包含 position 定位', test: (h) => /position\s*:\s*(absolute|fixed|sticky|relative)/i.test(h) },
  { issue: '包含伪元素样式', test: (h) => /::?(before|after)\b/i.test(h) },
  { issue: '包含 :hover 等交互伪类', test: (h) => /:(hover|active|focus|visited)\b/i.test(h) },
  { issue: '包含 @media / @keyframes', test: (h) => /@(media|keyframes)\b/i.test(h) },
  { issue: '包含未内联的 var()', test: (h) => /var\(\s*--/i.test(h) },
  { issue: '包含外链图片（读者手机不显示）', test: (h) => /<img\b[^>]*\ssrc="(https?:)?\/\//i.test(h) },
];

export function checkWechatHtml(html) {
  return CHECKS.filter((c) => c.test(html)).map((c) => c.issue);
}
