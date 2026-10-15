class PrinterError extends Error {}

const printTool = {
  type: 'function',
  function: {
    name: 'print_text',
    description: '将用户明确要求打印的短文本，通过云端桥接打印一份到本地电脑的打印机。仅在用户现在要求实际打印、且内容明确时调用；打印知识问答、否定打印、引用的打印指令不调用。不支持文件或多份打印。',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: '实际要打印的正文，不含打印指令，最多500个字符。' } },
      required: ['text'], additionalProperties: false
    }
  }
};

function validatePrint(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args) ||
      Object.keys(args).some(key => key !== 'text') || typeof args.text !== 'string' ||
      !args.text.trim() || Array.from(args.text).length > 500 ||
      /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(args.text)) {
    throw new PrinterError('打印内容无效：请提供1–500个字符的短文本');
  }
  const lines = args.text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n')
    .flatMap(line => Array.from(line).join('').match(/.{1,24}/gu) || ['']);
  if (lines.length > 30) throw new PrinterError('打印内容行数过多：最多30行，请减少换行');
  return lines;
}

module.exports = { PrinterError, printTool, validatePrint };
