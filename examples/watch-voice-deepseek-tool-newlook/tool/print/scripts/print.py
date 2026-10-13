#!/usr/bin/env python3
"""统一打印工具：文本 / 图片 / PDF / Office 文档 → 指定打印机。

所有内容都走 GDI 打印机 DC 自己排版，不发 GUI 打印对话框，
所以 agent 可以无人值守地调用。

    print.py text "中华人民万岁" --size 72
    print.py file report.pdf
    print.py file a.png b.jpg --copies 2
    print.py list
    print.py status
"""

from __future__ import annotations

import argparse
import sys
import tempfile
import time
from pathlib import Path

import win32con
import win32gui
import win32print
import win32ui

DEFAULT_PRINTER = "NPI689498 (HP LaserJet MFP M233dw)"
DEFAULT_FONT = "微软雅黑"

TEXT_EXT = {
    ".txt", ".md", ".markdown", ".rst", ".log", ".csv", ".tsv", ".json",
    ".yaml", ".yml", ".xml", ".html", ".htm", ".ini", ".cfg", ".conf",
    ".py", ".js", ".ts", ".java", ".c", ".h", ".cpp", ".cs", ".go", ".rs",
    ".sh", ".bat", ".ps1", ".sql", ".toml", ".env",
}
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".bmp", ".gif", ".tif", ".tiff", ".webp"}
OFFICE_EXT = {".doc", ".docx", ".rtf"}
PDF_EXT = {".pdf"}

# 任务状态位（JOB_STATUS_*），与打印机状态位不是同一套
JOB_FLAGS = {
    0x0001: "已暂停", 0x0002: "错误", 0x0004: "正在删除",
    0x0008: "正在缓存", 0x0010: "打印中", 0x0020: "脱机",
    0x0040: "缺纸", 0x0080: "已打印", 0x0100: "已删除",
    0x0200: "被设备队列阻塞", 0x0400: "需要人工干预",
    0x0800: "重启", 0x1000: "已完成", 0x2000: "保留",
    0x4000: "本地渲染",
}
# 打印机状态位（PRINTER_STATUS_*）
PRINTER_FLAGS = {
    0x00000001: "已暂停", 0x00000002: "错误", 0x00000008: "卡纸",
    0x00000010: "缺纸", 0x00000080: "脱机", 0x00000100: "IO 活动",
    0x00000200: "忙", 0x00000400: "打印中", 0x00001000: "不可用",
    0x00002000: "等待中", 0x00004000: "处理中", 0x00008000: "初始化中",
    0x00020000: "碳粉不足", 0x00040000: "无碳粉",
    0x00100000: "需要人工干预", 0x00400000: "机盖打开",
    0x01000000: "省电模式", 0x10000000: "服务器脱机",
}


def job_flags(value: int) -> str:
    names = [n for bit, n in sorted(JOB_FLAGS.items()) if value & bit]
    return "、".join(names) or f"0x{value:x}"


def printer_flags(value: int) -> str:
    names = [n for bit, n in sorted(PRINTER_FLAGS.items()) if value & bit]
    return "、".join(names) or "就绪"


def all_printers() -> list[str]:
    return [p[2] for p in win32print.EnumPrinters(
        win32print.PRINTER_ENUM_LOCAL | win32print.PRINTER_ENUM_CONNECTIONS,
        None, 1,
    )]


def resolve_printer(name: str) -> str:
    names = all_printers()
    if name in names:
        return name
    hits = [n for n in names if name.lower() in n.lower()]
    if len(hits) == 1:
        return hits[0]
    if not hits:
        raise SystemExit(f"找不到打印机 {name!r}。可用：\n  " + "\n  ".join(names))
    raise SystemExit(f"{name!r} 匹配到多台：\n  " + "\n  ".join(hits))


DUPLEX_MODES = {"long": 2, "short": 3}   # DMDUP_VERTICAL / DMDUP_HORIZONTAL
DM_DUPLEX = 0x1000
DC_DUPLEX = 7


def supports_duplex(printer: str) -> bool:
    handle = win32print.OpenPrinter(printer)
    try:
        port = win32print.GetPrinter(handle, 2)["pPortName"]
    finally:
        win32print.ClosePrinter(handle)
    return bool(win32print.DeviceCapabilities(printer, port, DC_DUPLEX))


def duplex_devmode(printer: str, mode: int):
    """取默认 DEVMODE，改成指定双面模式，再交给驱动合并校验。"""
    hprinter = win32print.OpenPrinter(printer)
    try:
        devmode = win32print.GetPrinter(hprinter, 2)["pDevMode"]
        devmode.Duplex = mode
        devmode.Fields |= DM_DUPLEX
        # DM_IN_BUFFER|DM_OUT_BUFFER：驱动会校验并回填，非法值会被打回单面
        win32print.DocumentProperties(0, hprinter, printer, devmode, devmode,
                                      win32con.DM_IN_BUFFER | win32con.DM_OUT_BUFFER)
    finally:
        win32print.ClosePrinter(hprinter)

    if devmode.Duplex != mode:
        raise SystemExit(f"打印机 {printer} 拒绝双面设置（驱动回退为单面）。")
    return devmode


def open_dc(printer: str, duplex: str | None = None):
    """打开打印机 DC。duplex 为 None 时用驱动默认（单面）。"""
    if duplex is None:
        dc = win32ui.CreateDC()
        dc.CreatePrinterDC(printer)
        return dc

    if not supports_duplex(printer):
        raise SystemExit(f"打印机 {printer} 不支持双面打印。去掉 --duplex 即可单面打印。")

    handle = win32gui.CreateDC("WINSPOOL", printer,
                               duplex_devmode(printer, DUPLEX_MODES[duplex]))
    return win32ui.CreateDCFromHandle(handle)


def parse_page_range(spec: str, total: int) -> list[int]:
    """把 '1,3-5,8-' 解析成 1 起的页码列表，按给定顺序去重。

    显式写出的上界超出总页数会报错；开区间 'N-' 才表示'到末页'。
    """
    picked: list[int] = []
    for raw in spec.replace("，", ",").split(","):
        part = raw.strip()
        if not part:
            continue
        if part.startswith("-"):
            raise SystemExit(f"页码范围 {part!r} 看不懂。前两页写 1-2，不是 -2。")

        lo_s, sep, hi_s = part.partition("-")
        explicit_hi = bool(sep) and bool(hi_s.strip())
        try:
            lo = int(lo_s)
            hi = int(hi_s) if explicit_hi else (total if sep else lo)
        except ValueError:
            raise SystemExit(
                f"页码范围 {part!r} 不是有效写法。用 1 / 3-5 / 2- 这种形式。"
            ) from None

        if lo < 1:
            raise SystemExit(f"页码范围 {part!r} 无效：页码从 1 开始。")
        if lo > total:
            raise SystemExit(f"页码范围 {part!r} 超出：这份文件共 {total} 页。")
        if explicit_hi and hi < lo:
            raise SystemExit(f"页码范围 {part!r} 无效：起点大于终点。")
        if explicit_hi and hi > total:
            raise SystemExit(f"页码范围 {part!r} 超出：这份文件共 {total} 页。")

        for n in range(lo, min(hi, total) + 1):
            if n not in picked:
                picked.append(n)

    if not picked:
        raise SystemExit(f"页码范围 {spec!r} 没有选中任何页。")
    return picked


def sheets_needed(stream_pages: int, duplex: str | None) -> int:
    return (stream_pages + 1) // 2 if duplex else stream_pages


def sniff_kind(path: Path) -> str | None:
    """按开头几字节判断真实类型：'pdf' / 'binary'，拿不准返回 None。"""
    try:
        head = path.open("rb").read(4096)
    except OSError:
        return None
    if head.startswith(b"%PDF-"):
        return "pdf"
    if b"\x00" in head:
        return "binary"
    return None


def margin_value(text: str) -> float:
    try:
        value = float(text)
    except ValueError:
        raise argparse.ArgumentTypeError(f"{text!r} 不是数字") from None
    # 注意 nan 会让下面两个比较都为假，所以必须写成这种区间判断
    if not (0 <= value <= 80):
        raise argparse.ArgumentTypeError(
            "--margin 要在 0~80 毫米之间（负边距会把内容推出纸外，"
            "太大则没地方排内容）"
        )
    return value


def dpi_value(text: str) -> int:
    try:
        value = int(text)
    except ValueError:
        raise argparse.ArgumentTypeError(f"{text!r} 不是整数") from None
    if not 50 <= value <= 1200:
        raise argparse.ArgumentTypeError("--dpi 要在 50~1200 之间")
    return value


def read_text(path: Path) -> str:
    raw = path.read_bytes()
    for enc in ("utf-8-sig", "utf-8", "gb18030", "utf-16"):
        try:
            return raw.decode(enc)
        except (UnicodeDecodeError, LookupError):
            continue
    return raw.decode("utf-8", errors="replace")


class Page:
    """一页内容：在 DC 上画出自己。"""

    def draw(self, dc) -> None:
        raise NotImplementedError


class TextPage(Page):
    def __init__(self, items, font_spec):
        self.items = items          # [(x, y, line)]
        self.font_spec = font_spec

    def draw(self, dc):
        dc.SelectObject(win32ui.CreateFont(self.font_spec))
        dc.SetBkMode(win32con.TRANSPARENT)
        dc.SetTextColor(0x000000)
        for x, y, line in self.items:
            dc.TextOut(x, y, line)


class ImagePage(Page):
    def __init__(self, image, rect):
        self.image = image
        self.rect = rect

    def draw(self, dc):
        from PIL import ImageWin
        ImageWin.Dib(self.image).draw(dc.GetHandleOutput(), self.rect)


def make_image_page(img, rect):
    """图比目标矩形大就先缩到矩形大小再交给 GDI。

    多出来的像素驱动本来也会丢掉（StretchDIBits 要缩），但**过大的位图
    会让 GDI 往打印机 DC 记录 EMF 时静默失败**：任务 spool 出 0 字节、
    整页空白，而且不报任何错（内存 DC 不受影响，所以离屏自测发现不了）。
    """
    from PIL import Image
    target = (rect[2] - rect[0], rect[3] - rect[1])
    if img.width > target[0] or img.height > target[1]:
        img = img.resize(target, Image.LANCZOS)
    return ImagePage(img, rect)


def make_font(font_name, size_pt, dpi_y, bold=False):
    return {
        "name": font_name,
        "height": -int(round(size_pt * dpi_y / 72.0)),
        "weight": win32con.FW_BOLD if bold else win32con.FW_NORMAL,
        "charset": win32con.DEFAULT_CHARSET,
    }


def measure(dc, font_spec, text):
    dc.SelectObject(win32ui.CreateFont(font_spec))
    return dc.GetTextExtent(text)


FOOTER_PT = 9


class Footer:
    """页脚：底部右对齐的 '标题 | 页码'。

    step=2 时隔页打：只有第 0、2、4… 个打印页有页脚，编号只在有页脚的页上递增，
    所以双面打印时正好是每张物理纸正面一个编号。
    """

    def __init__(self, dc, start, title, font_name, margin_mm, step=1):
        dpi_x = dc.GetDeviceCaps(win32con.LOGPIXELSX)
        dpi_y = dc.GetDeviceCaps(win32con.LOGPIXELSY)
        page_w = dc.GetDeviceCaps(win32con.HORZRES)
        page_h = dc.GetDeviceCaps(win32con.VERTRES)

        self.font_spec = make_font(font_name, FOOTER_PT, dpi_y)
        self.line_h = measure(dc, self.font_spec, "A汉")[1]
        self.band = int(self.line_h * 1.5)   # 正文区要让出的高度
        self.y = page_h - int(margin_mm / 25.4 * dpi_y) - self.line_h
        self.left = int(round(margin_mm / 25.4 * dpi_x))
        self.right = page_w - self.left
        self.start = start
        self.title = title
        self.step = step

    def text_for(self, ordinal: int) -> str:
        """第 ordinal 个页脚的文本（从 0 起，只数真正打页脚的那些页）。"""
        number = self.start + ordinal
        return f"{self.title} | {number}" if self.title else str(number)

    def _fit(self, dc, text: str) -> str:
        """标题太长时从左边截断，保证右边的页码始终落在纸内。"""
        limit = self.right - self.left
        if dc.GetTextExtent(text)[0] <= limit:
            return text
        lo, hi = 0, len(text)
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if dc.GetTextExtent("…" + text[-mid:])[0] <= limit:
                lo = mid
            else:
                hi = mid - 1
        return "…" + text[-lo:] if lo else ""

    def draw(self, dc, ordinal: int) -> None:
        dc.SelectObject(win32ui.CreateFont(self.font_spec))
        dc.SetBkMode(win32con.TRANSPARENT)
        dc.SetTextColor(0x000000)
        text = self._fit(dc, self.text_for(ordinal))
        dc.TextOut(self.right - dc.GetTextExtent(text)[0], self.y, text)


class FooteredPage(Page):
    def __init__(self, inner, footer: Footer, ordinal: int):
        self.inner = inner
        self.footer = footer
        self.ordinal = ordinal      # 第几个页脚，不是第几页

    def draw(self, dc):
        self.inner.draw(dc)
        self.footer.draw(dc, self.ordinal)


DEFAULT_FOOTER_STEP = 2


def footer_step(args) -> int:
    """没显式给就默认隔页打（双面时等于每张纸正面一个编号）。"""
    if args.page_number_step is not None:
        return args.page_number_step
    return DEFAULT_FOOTER_STEP


def make_footer(dc, start, title, font_name, margin_mm, step=1):
    if start is None:
        return None
    return Footer(dc, start, title, font_name, margin_mm, step)


def apply_footer(pages, footer):
    """按 step 隔页套页脚；没页脚的那几页原样保留。"""
    if footer is None:
        return pages
    return [
        FooteredPage(page, footer, i // footer.step) if i % footer.step == 0 else page
        for i, page in enumerate(pages)
    ]


def footer_ordinals(footer: Footer, page_count: int) -> list[int]:
    return [i // footer.step for i in range(page_count) if i % footer.step == 0]


def describe_footer(footer: Footer, page_count: int) -> str:
    ordinals = footer_ordinals(footer, page_count)
    if not ordinals:
        return "（无）"
    if len(ordinals) == 1:
        text = footer.text_for(ordinals[0])
    else:
        text = f"{footer.text_for(ordinals[0])} … {footer.text_for(ordinals[-1])}"
    if footer.step == 2:
        text += f"（隔页打，共 {len(ordinals)} 处）"
    elif footer.step > 2:
        text += f"（每 {footer.step} 个打印页打一次，共 {len(ordinals)} 处）"
    return text


def wrap_paragraph(dc, font_spec, para, usable_w):
    """二分找断点，优先在空格处断，保证每行实测宽度不超限。"""
    out = []
    rest = para
    while rest:
        lo, hi, best = 1, len(rest), 1
        while lo <= hi:
            mid = (lo + hi) // 2
            if measure(dc, font_spec, rest[:mid])[0] <= usable_w:
                best, lo = mid, mid + 1
            else:
                hi = mid - 1
        cut = best
        if cut < len(rest) and not rest[cut - 1].isspace():
            space = rest.rfind(" ", max(0, cut // 2), cut)
            if space > 0:
                cut = space + 1
        out.append(rest[:cut].rstrip())
        rest = rest[cut:]
    return out


def build_text_pages(dc, paragraphs, font_name, size_pt, bold, align, margin_mm,
                     line_gap, wrap, reserve_bottom=0):
    """把段落排成多页，返回 (pages, info)。"""
    if not any(p.strip() for p in paragraphs):
        raise SystemExit("内容全是空白，打出来就是一张白纸，已取消。")

    dpi_x = dc.GetDeviceCaps(win32con.LOGPIXELSX)
    dpi_y = dc.GetDeviceCaps(win32con.LOGPIXELSY)
    page_w = dc.GetDeviceCaps(win32con.HORZRES)
    page_h = dc.GetDeviceCaps(win32con.VERTRES)
    margin = int(round(margin_mm / 25.4 * dpi_x))
    usable_w = page_w - 2 * margin
    usable_h = page_h - 2 * margin - reserve_bottom
    if usable_w <= 0 or usable_h <= 0:
        raise SystemExit(
            f"页边距 {margin_mm:g}mm 太大，A4 可打印区装不下正文了"
            f"（只剩 {usable_w}×{usable_h}px）。把 --margin 调小些。"
        )

    size = size_pt
    while True:
        font_spec = make_font(font_name, size, dpi_y, bold)
        line_h = int(measure(dc, font_spec, "汉Ag")[1] * line_gap)

        if wrap:
            visual = []
            for para in paragraphs:
                visual.extend(wrap_paragraph(dc, font_spec, para, usable_w)
                              if para else [""])
            break

        widest = max((measure(dc, font_spec, p)[0] for p in paragraphs), default=0)
        if widest <= usable_w or size <= 6:
            visual = list(paragraphs)
            break
        size -= 1

    lines_per_page = max(1, usable_h // line_h)
    pages = []
    for start in range(0, max(1, len(visual)), lines_per_page):
        chunk = visual[start:start + lines_per_page]
        items = []
        y = margin
        for line in chunk:
            width = measure(dc, font_spec, line)[0] if line else 0
            if align == "center":
                x = max(margin, (page_w - width) // 2)
            elif align == "right":
                x = max(margin, page_w - margin - width)
            else:
                x = margin
            items.append((x, y, line))
            y += line_h
        pages.append(TextPage(items, font_spec))

    info = {
        "font_pt": size,
        "line_height_px": line_h,
        "lines_per_page": lines_per_page,
        "fonts": font_spec,
        "page_px": (page_w, page_h),
        "dpi": (dpi_x, dpi_y),
    }
    return pages, info


def fit_rect(img_w, img_h, page_w, page_h, margin_px, reserve_bottom=0):
    avail_w = page_w - 2 * margin_px
    avail_h = page_h - 2 * margin_px - reserve_bottom
    if avail_w <= 0 or avail_h <= 0:
        raise SystemExit(
            f"页边距太大，A4 可打印区装不下图片了"
            f"（只剩 {avail_w}×{avail_h}px，会画出纸外）。把 --margin 调小些。"
        )
    scale = min(avail_w / img_w, avail_h / img_h)
    w, h = int(img_w * scale), int(img_h * scale)
    x = (page_w - w) // 2
    y = margin_px + (avail_h - h) // 2
    return (x, y, x + w, y + h)


def pages_from_pdf(path: Path, dc, dpi, page_spec: str | None = None,
                   reserve_bottom: int = 0, margin_mm: float = 15):
    import fitz
    from PIL import Image

    doc = fitz.open(str(path))
    page_w = dc.GetDeviceCaps(win32con.HORZRES)
    page_h = dc.GetDeviceCaps(win32con.VERTRES)
    dpi_x = dc.GetDeviceCaps(win32con.LOGPIXELSX)
    dpi_y = dc.GetDeviceCaps(win32con.LOGPIXELSY)
    # 必须和正文、页脚用同一个边距，否则页脚会压到图上
    margin_px = int(round(margin_mm / 25.4 * min(dpi_x, dpi_y)))

    selected = (list(range(1, len(doc) + 1)) if page_spec is None
                else parse_page_range(page_spec, len(doc)))

    pages = []
    for number in selected:
        pix = doc[number - 1].get_pixmap(dpi=dpi)
        img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
        pages.append(make_image_page(img, fit_rect(img.width, img.height, page_w,
                                                   page_h, margin_px, reserve_bottom)))
    doc.close()
    return pages


def pages_from_images(paths, dc, reserve_bottom=0, margin_mm=15):
    from PIL import Image

    page_w = dc.GetDeviceCaps(win32con.HORZRES)
    page_h = dc.GetDeviceCaps(win32con.VERTRES)
    dpi_x = dc.GetDeviceCaps(win32con.LOGPIXELSX)
    dpi_y = dc.GetDeviceCaps(win32con.LOGPIXELSY)
    margin_px = int(round(margin_mm / 25.4 * min(dpi_x, dpi_y)))

    pages = []
    for path in paths:
        img = Image.open(path)
        if img.mode not in ("RGB", "L"):
            img = img.convert("RGB")
        pages.append(make_image_page(img, fit_rect(img.width, img.height, page_w,
                                                   page_h, margin_px, reserve_bottom)))
    return pages


def office_to_pdf(path: Path) -> Path:
    import win32com.client

    # COM 按 WPS 自己的工作目录解析相对路径，必须先转绝对路径
    src = path.resolve()
    out = Path(tempfile.gettempdir()) / (src.stem + "_print.pdf")
    if out.exists():
        out.unlink()

    try:
        app = win32com.client.Dispatch("KWPS.Application")
    except Exception as exc:
        raise SystemExit(f"启动 WPS 失败（{src.name}）：{exc}") from exc

    try:
        app.Visible = False
        doc = app.Documents.Open(str(src), ReadOnly=True)
        doc.SaveAs(str(out), FileFormat=17)   # wdFormatPDF
        doc.Close(0)
    except SystemExit:
        raise
    except Exception as exc:
        raise SystemExit(
            f"WPS 转换 {src.name} 失败：{exc}\n"
            f"可以先在 WPS 里手动另存为 PDF，再打印那个 PDF。"
        ) from exc
    finally:
        try:
            app.Quit()
        except Exception:
            pass

    if not out.exists():
        raise SystemExit(f"WPS 没有生成 PDF：{src.name}")
    return out


def snapshot_jobs(printer: str) -> set[int]:
    handle = win32print.OpenPrinter(printer)
    try:
        return {j["JobId"] for j in win32print.EnumJobs(handle, 0, 999, 1)}
    finally:
        win32print.ClosePrinter(handle)


def wait_for_jobs(printer: str, job_ids: set[int], timeout: int) -> dict:
    """轮询队列，直到我们的任务离开队列或超时。"""
    deadline = time.monotonic() + timeout
    last = {}
    while True:
        handle = win32print.OpenPrinter(printer)
        try:
            info = win32print.GetPrinter(handle, 2)
            current = {j["JobId"]: j for j in win32print.EnumJobs(handle, 0, 999, 1)}
        finally:
            win32print.ClosePrinter(handle)

        remaining = job_ids & set(current)
        if remaining:
            last = {jid: current[jid] for jid in remaining}
        else:
            return {
                "done": True,
                "printer_status": printer_flags(info["Status"]),
                "cJobs": info["cJobs"],
            }
        if time.monotonic() > deadline or not remaining:
            break
        time.sleep(2)

    return {
        "done": False,
        "printer_status": printer_flags(info["Status"]),
        "cJobs": info["cJobs"],
        "pending": {jid: job_flags(j["Status"]) for jid, j in last.items()},
    }


def submit(printer: str, doc_name: str, pages, copies: int, dry_run: bool,
           wait: int, duplex: str | None = None, footer=None) -> dict:
    # 没有页却照样 StartDoc/EndDoc，后台可能吐一张空白页出来
    if not pages:
        raise SystemExit("没有任何页可打（页码范围为空？），已取消，免得吐空白页。")
    if copies < 1:
        raise SystemExit(f"份数必须 ≥ 1，收到 {copies}。")

    # 页脚编号跟着实际打印出来的整条页流走，多份也连起来 ——
    # 若每份各自重排，奇数页数的文档双面时编号会跑到纸背面上
    stream = apply_footer(pages * copies, footer)

    dc = open_dc(printer, duplex)
    try:
        result = {
            "printer": printer,
            "document": doc_name,
            "pages": len(pages),
            "copies": copies,
            "total_sheets": sheets_needed(len(stream), duplex),
            "duplex": duplex,
        }
        # 偶数 step 的倍数都是偶数流位（=纸正面），奇数 step 就会踩到纸背面
        if duplex and footer and footer.step > 1 and footer.step % 2 == 1:
            result["warning"] = (
                f"双面 + 每 {footer.step} 个打印页一个编号：{footer.step} 是奇数，"
                f"部分编号会落在纸背面上（正反面错位）。"
                f"想让编号只落在纸正面，把 --page-number-step 改成偶数（2 最合适）。"
            )
        if dry_run:
            result["dry_run"] = True
            return result

        before = snapshot_jobs(printer)
        dc.StartDoc(doc_name)
        for page in stream:
            dc.StartPage()
            page.draw(dc)
            dc.EndPage()
        dc.EndDoc()

        new_jobs = snapshot_jobs(printer) - before
        if not new_jobs:
            result["verified"] = False
            result["note"] = "提交后队列里没看到对应任务，可能已被打印机瞬间取走"
            return result

        result["job_ids"] = sorted(new_jobs)
        if wait > 0:
            result["verification"] = wait_for_jobs(printer, new_jobs, wait)
        return result
    finally:
        dc.DeleteDC()


def report(result: dict) -> None:
    face = {"long": "双面·长边翻转", "short": "双面·短边翻转"}.get(
        result.get("duplex"), "单面")
    print(f"打印机 : {result['printer']}")
    if footer := result.get("footer"):
        print(f"页脚   : {footer}")
    if warning := result.get("warning"):
        print(f"警告   : {warning}")
    if result.get("dry_run"):
        print(f"[dry-run] {result['document']}  共 {result['pages']} 页 "
              f"x {result['copies']} 份 = {result['total_sheets']} 张（{face}），未发送任务")
        return

    print(f"文档   : {result['document']}")
    print(f"规模   : {result['pages']} 页 x {result['copies']} 份 = "
          f"{result['total_sheets']} 张（{face}）")
    if "job_ids" in result:
        print(f"任务号 : {result['job_ids']}")

    v = result.get("verification")
    if v and v["done"]:
        print(f"结果   : 任务已离开队列，打印机状态 {v['printer_status']}")
    elif v:
        pending = "、".join(f"{k}({s})" for k, s in v.get("pending", {}).items())
        print(f"结果   : 超时，任务仍在队列 {pending}；"
              f"打印机状态 {v['printer_status']}")
    else:
        print(f"结果   : {result.get('note', '已提交')}")


def cmd_list(args) -> int:
    default = win32print.GetDefaultPrinter()
    for name in all_printers():
        print(f"{'*' if name == default else ' '} {name}")
    return 0


def cmd_status(args) -> int:
    printer = resolve_printer(args.printer)
    handle = win32print.OpenPrinter(printer)
    try:
        info = win32print.GetPrinter(handle, 2)
        print(f"打印机 : {printer}")
        print(f"状态   : {printer_flags(info['Status'])}")
        print(f"队列   : {info['cJobs']} 个任务")
        for j in win32print.EnumJobs(handle, 0, 999, 1):
            print(f"  #{j['JobId']:<4} {j['pDocument']!r}  {job_flags(j['Status'])}"
                  f"  {j.get('pUserName', '')}")
    finally:
        win32print.ClosePrinter(handle)
    return 0


def cmd_text(args) -> int:
    printer = resolve_printer(args.printer)
    dc = open_dc(printer, args.duplex)
    try:
        footer = make_footer(dc, args.page_number, args.title, args.font,
                             args.margin, footer_step(args))
        pages, info = build_text_pages(
            dc, args.lines, args.font, args.size, args.bold, args.align,
            args.margin, args.line_gap, wrap=False,
            reserve_bottom=footer.band if footer else 0,
        )
    finally:
        dc.DeleteDC()

    result = submit(printer, "print_text", pages, args.copies, args.dry_run,
                    args.wait, args.duplex, footer)
    result["font_pt"] = info["font_pt"]
    if footer:
        result["footer"] = describe_footer(footer, len(pages) * args.copies)
    report(result)
    if info["font_pt"] != args.size:
        print(f"提示   : 内容过宽，字号已从 {args.size}pt 自动缩到 {info['font_pt']}pt")
    return 0


def cmd_file(args) -> int:
    printer = resolve_printer(args.printer)

    if args.pages is not None:
        if len(args.paths) > 1:
            raise SystemExit(
                "--pages 只能配一个文件。要分别指定页码范围，请分多次调用。"
            )
        if Path(args.paths[0]).suffix.lower() not in PDF_EXT | OFFICE_EXT:
            raise SystemExit(
                f"--pages 只对 PDF / doc / docx / rtf 有意义；"
                f"{Path(args.paths[0]).name} 是被重新排版分页的，页码对不上。"
            )

    dc = open_dc(printer, args.duplex)
    try:
        footer = make_footer(dc, args.page_number, args.title, args.font,
                             args.margin, footer_step(args))
        reserve = footer.band if footer else 0
        pages = []
        names = []
        for raw in args.paths:
            path = Path(raw)
            if not path.exists():
                raise SystemExit(f"文件不存在：{path}")
            if path.is_dir():
                raise SystemExit(f"{path} 是目录不是文件。")
            ext = path.suffix.lower()
            names.append(path.name)
            kind = sniff_kind(path)

            try:
                if kind == "pdf":       # 按内容认，扩展名写错也照样打对
                    pages += pages_from_pdf(path, dc, args.dpi, args.pages,
                                            reserve, args.margin)
                elif ext in IMAGE_EXT:
                    pages += pages_from_images([path], dc, reserve, args.margin)
                elif ext in OFFICE_EXT:
                    pdf = office_to_pdf(path)
                    pages += pages_from_pdf(pdf, dc, args.dpi, args.pages,
                                            reserve, args.margin)
                elif ext in PDF_EXT:
                    raise SystemExit(f"{path.name} 扩展名是 .pdf，但内容不是有效 PDF"
                                     f"（空的或已损坏）。")
                elif ext in TEXT_EXT or not ext:
                    if kind == "binary":
                        raise SystemExit(
                            f"{path.name} 看着是二进制文件，不是文本。"
                            f"按文本打会全是乱码，已取消。"
                        )
                    text_pages, _ = build_text_pages(
                        dc, read_text(path).splitlines(), args.font, args.size,
                        False, "left", args.margin, 1.15, wrap=True,
                        reserve_bottom=reserve,
                    )
                    pages += text_pages
                else:
                    raise SystemExit(
                        f"不支持的格式 {ext}（{path.name}）。"
                        f"支持 文本/图片/PDF/doc/docx/rtf。"
                    )
            except SystemExit:
                raise
            except Exception as exc:
                raise SystemExit(
                    f"读取 {path.name} 失败（{type(exc).__name__}: {exc}）。"
                    f"文件可能已损坏或不是它扩展名声称的格式。"
                ) from exc
    finally:
        dc.DeleteDC()

    result = submit(printer, ",".join(names), pages, args.copies, args.dry_run,
                    args.wait, args.duplex, footer)
    if footer:
        result["footer"] = describe_footer(footer, len(pages) * args.copies)
    report(result)
    return 0


def add_common(parser, suppress_defaults=False):
    """全局参数。子解析器上用 SUPPRESS，免得把上层已解析的值覆盖成默认值。

    这样 `--dry-run` 放在子命令前或后都能用。
    """
    d = (lambda v: argparse.SUPPRESS) if suppress_defaults else (lambda v: v)
    parser.add_argument("--printer", default=d(DEFAULT_PRINTER),
                        help="打印机名（可子串匹配）")
    parser.add_argument("--copies", type=int, default=d(1), help="份数")
    parser.add_argument("--dry-run", action="store_true", default=d(False),
                        help="只算页数，不发送任务")
    parser.add_argument("--wait", type=int, default=d(60),
                        help="打印后等待队列清空的秒数，0 表示不等待")
    parser.add_argument("--duplex", choices=["long", "short"], default=d(None),
                        help="双面：long=长边翻转（书），short=短边翻转（台历）；不传=单面")
    parser.add_argument("--pages", default=d(None),
                        help="页码范围，如 1,3-5,8-（只对 file 子命令且只配单个文件）")
    parser.add_argument("--page-number", type=int, default=d(None), metavar="N",
                        help="在页脚打页码，从 N 开始逐页递增；不传则不打页码")
    parser.add_argument("--title", default=d(None),
                        help="页脚前缀，格式 '标题 | 页码'；必须配合 --page-number")
    parser.add_argument("--page-number-step", type=int, default=d(None), metavar="K",
                        help="每隔 K 个打印页打一次页脚，默认 2（隔页打）；"
                             "填 1 就是每页都打")


def main() -> int:
    parser = argparse.ArgumentParser(description="把文本/文件打印到指定打印机")
    add_common(parser)

    sub = parser.add_subparsers(dest="command", required=True)

    p_text = sub.add_parser("text", help="打印一段文本")
    add_common(p_text, suppress_defaults=True)
    p_text.add_argument("lines", nargs="+", help="要打印的文本，多个参数=多行")
    p_text.add_argument("--font", default=DEFAULT_FONT)
    p_text.add_argument("--size", type=float, default=48)
    p_text.add_argument("--bold", action="store_true")
    p_text.add_argument("--align", choices=["left", "center", "right"], default="center")
    p_text.add_argument("--margin", type=margin_value, default=15)
    p_text.add_argument("--line-gap", type=float, default=1.2)
    p_text.set_defaults(func=cmd_text)

    p_file = sub.add_parser("file", help="打印文件（文本/图片/PDF/Office）")
    add_common(p_file, suppress_defaults=True)
    p_file.add_argument("paths", nargs="+", help="一个或多个文件路径")
    p_file.add_argument("--font", default=DEFAULT_FONT)
    p_file.add_argument("--size", type=float, default=12, help="文本文件字号，默认 12")
    p_file.add_argument("--margin", type=margin_value, default=15)
    p_file.add_argument("--dpi", type=dpi_value, default=600,
                        help="PDF 光栅化精度 50~1200，默认 600")
    p_file.set_defaults(func=cmd_file)

    p_list = sub.add_parser("list", help="列出所有打印机")
    add_common(p_list, suppress_defaults=True)
    p_list.set_defaults(func=cmd_list)

    p_status = sub.add_parser("status", help="查看打印机状态和队列")
    add_common(p_status, suppress_defaults=True)
    p_status.set_defaults(func=cmd_status)

    args = parser.parse_args()
    if args.pages is not None:
        if args.command != "file":
            parser.error(f"--pages 只能用于 file 子命令，不能配 {args.command}")
        if not args.pages.strip():
            parser.error("--pages 不能为空，空值会被当成'不过滤'而打掉整份文件。"
                         "要么给出页码，要么去掉这个参数。")
    if args.page_number is not None:
        if args.command not in ("text", "file"):
            parser.error(f"--page-number 只能用于 text / file，不能配 {args.command}")
        if args.page_number < 1:
            parser.error(f"--page-number 要 ≥ 1，收到 {args.page_number}。"
                         "（页码从 1 起算；想接着上一批的编号继续就填那个数）")
    if args.page_number_step is not None:
        if args.page_number is None:
            parser.error("--page-number-step 只在配了 --page-number 时才有意义 —— "
                         "现在压根没打页脚，也就无所谓隔几页。")
        if args.page_number_step < 1:
            parser.error(f"--page-number-step 要 ≥ 1，收到 {args.page_number_step}。"
                         "填 1 就是每页都打。")
    if args.title is not None:
        if args.page_number is None:
            parser.error("--title 是页脚前缀，得配合 --page-number 才有意义"
                         "（说了标题但没说起始页码，不知道页码从几开始）。"
                         "要么补上 --page-number N，要么去掉 --title。")
        if any(ord(ch) < 32 for ch in args.title):
            parser.error("--title 不能含换行、制表等控制字符 —— 打印时会被悄悄丢掉，"
                         "打出来跟你写的对不上。")
        if not args.title.strip().strip("​‌‍﻿"):
            parser.error("--title 不能为空。只想要没有标题的纯页码，"
                         "去掉 --title 就行，不用传空串。")
    return args.func(args)


if __name__ == "__main__":
    if sys.platform != "win32":
        sys.exit("此脚本仅支持 Windows。")
    # 结果行和报错信息都是中文，两个流都固定 UTF-8，免得在 GBK 控制台变乱码
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    raise SystemExit(main())
