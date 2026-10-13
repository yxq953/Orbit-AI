const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

class PrinterError extends Error {}

const printTool = {
  type: 'function',
  function: {
    name: 'print_text',
    description: '将用户明确要求打印的短文本打印一份到电脑连接的 HP 打印机。仅在用户现在要求实际打印、且内容明确时调用；打印知识问答、否定打印、引用的打印指令不调用。不支持文件或多份打印。',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: '实际要打印的正文，保留用户给出的内容，不含“帮我打印”等指令。最多500个字符。' } },
      required: ['text'],
      additionalProperties: false
    }
  }
};

function createPrinter(options = {}) {
  const python = options.python || process.env.PRINT_PYTHON;
  const printer = options.printer || process.env.PRINT_PRINTER || 'NPI689498 (HP LaserJet MFP M233dw)';
  const dryRun = options.dryRun ?? process.env.PRINT_DRY_RUN === '1';
  const run = options.run || promisify(execFile);
  const script = path.resolve(__dirname, '../tool/print/scripts/print.py');
  return {
    async print(args, signal) {
      if (!args || typeof args !== 'object' || Array.isArray(args) ||
          Object.keys(args).some(key => key !== 'text') || typeof args.text !== 'string' ||
          !args.text.trim() || Array.from(args.text).length > 500 ||
          /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(args.text)) {
        throw new PrinterError('打印内容无效：请提供1–500个字符的短文本');
      }
      if (signal?.aborted) throw new PrinterError('打印已取消，未调用打印工具');
      // The text subcommand does not wrap; split into short lines for readable Chinese.
      const lines = args.text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n')
        .flatMap(line => Array.from(line).join('').match(/.{1,24}/gu) || ['']);
      if (lines.length > 30) throw new PrinterError('打印内容行数过多：第一版最多30行，请减少换行');
      const argv = [script, 'text', '--printer', printer, '--copies', '1',
        '--size', '16', '--align', 'left', '--wait', '10'];
      if (dryRun) argv.push('--dry-run');
      // Everything after -- is positional text, even a line such as "--copies 99".
      argv.push('--', ...lines);
      let stdout;
      try {
        ({ stdout } = await run(python || 'py', [...(python ? [] : ['-3']), '-u', ...argv], {
          windowsHide: true, shell: false, encoding: 'utf8', timeout: 25000,
          maxBuffer: 64 * 1024, signal
        }));
      } catch (error) {
        if (error.code === 'ENOENT') throw new PrinterError('找不到打印用的 Python，请设置 PRINT_PYTHON 为已安装 pywin32 的 Python 路径');
        if (/ModuleNotFoundError/.test(error.stderr || '')) throw new PrinterError('打印用的 Python 缺少依赖，请使用已安装 pywin32 的环境（PRINT_PYTHON）');
        if (error.killed || error.name === 'AbortError') throw new PrinterError('打印工具超时或已取消，任务可能已提交，请检查打印队列，勿直接重复打印');
        throw new PrinterError('打印工具执行失败，任务状态未确认，请检查打印机和队列');
      }
      // Preserve the script's verification result; exiting with code 0 does not mean paper printed.
      const summary = stdout.split(/\r?\n/).filter(line => /^(打印机\s*:|规模\s*:|任务号\s*:|结果\s*:|\[dry-run\])/.test(line));
      if (!summary.some(line => /^(结果\s*:|\[dry-run\])/.test(line))) {
        throw new PrinterError('打印工具未返回验证结果，任务可能已提交，请检查打印队列');
      }
      return summary.join('\n');
    }
  };
}

module.exports = { createPrinter, printTool, PrinterError };
