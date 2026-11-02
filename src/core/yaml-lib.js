'use strict';
/**
 * yaml-lib.js —— 统一的 YAML 解析入口
 *
 * 为什么需要这层封装：
 *
 *   1. cordis patch 文件允许 `!!js` 表达式（`disabled: !!js ...`、
 *      `config.x: !!js process.env.X`）。yaml 库默认不认识这个自定义标签，
 *      会抛 TAG_RESOLVE_FAILED 警告并把它当普通字符串。
 *      注册自定义标签后，我们能把"动态表达式"和"字面字符串"区分开——
 *      这对判断插件启停状态至关重要：动态 disabled 不能静态求值，
 *      必须如实告诉用户"这是动态的，我读不出来"，而不是猜一个值。
 *
 *   2. ⚠ 绝对不能用 logLevel: 'silent'。
 *      实测发现它会把**真正的语法错误也一起静默**：
 *      畸形文件 `- id: x / <三个空格>bad_indent: [unclosed`
 *      正常解析会抛 "Nested mappings are not allowed in compact mapping"，
 *      但加上 silent 后会被"成功"解析成 {id: {"x bad_indent": ["unclosed"]}}。
 *      对写入模块来说这是灾难：损坏的文件会被当成合法文件接受，
 *      然后在上面继续追加，问题只会越埋越深。
 *
 *      正确做法是让错误照常抛出，只在**已知无害**的警告场景下放行。
 *      这里的选择是：解析错误一律抛给调用方，由调用方决定怎么处理。
 *      注册了 !!js 标签之后，本来也不会再产生 TAG_RESOLVE_FAILED 警告。
 */

const path = require('path');

let cached = null;

/** `!!js` 标签：保留原始表达式文本，标记为动态值。 */
const jsTag = {
  tag: 'tag:yaml.org,2002:js',
  resolve(value) {
    return { __jsExpression: String(value).trim() };
  },
};

function load() {
  if (cached) return cached;

  const candidates = [
    path.join(__dirname, '..', '..', 'lib', 'yaml', 'dist', 'index.js'),
    'yaml',
  ];

  let yaml = null;
  for (const c of candidates) {
    try {
      yaml = require(c);
      break;
    } catch {
      /* 试下一个 */
    }
  }
  if (!yaml) {
    throw new Error('找不到 YAML 解析库（lib/yaml/dist/index.js）');
  }

  cached = {
    /**
     * 解析成普通 JS 对象；`!!js` 解析为 { __jsExpression }。
     * 语法错误照常抛出——这是必须让调用方看到的信息。
     */
    parse(text) {
      return yaml.parse(text, { customTags: [jsTag] });
    },
    /** 判断一个值是否为动态表达式 */
    isDynamic(v) {
      return (
        v != null &&
        typeof v === 'object' &&
        typeof v.__jsExpression === 'string'
      );
    },
    /** 取动态表达式的原文 */
    expressionOf(v) {
      return v && typeof v === 'object' ? v.__jsExpression : null;
    },
    raw: yaml,
  };

  return cached;
}

module.exports = { load };
