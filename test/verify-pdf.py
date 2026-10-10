#!/usr/bin/env python3
"""
PDF 结构校验器。

PDF 最容易写错的地方是 xref 表的字节偏移：它记录每个对象在文件里的绝对位置，
一旦算错，严谨的阅读器就会拒绝打开（浏览器往往宽容，所以本地测不出来）。
这个脚本逐条核对偏移，并把嵌入的 JPEG 原样抽出来验证完整性。

用法：python test/verify-pdf.py test/output/sample.pdf
"""

import os
import re
import sys


def check(cond, msg, errors):
    if cond:
        print(f"  [OK]   {msg}")
    else:
        print(f"  [FAIL] {msg}")
        errors.append(msg)


def main(path):
    errors = []
    data = open(path, "rb").read()
    print(f"校验 {path}  ({len(data)} 字节)\n")

    # --- 1. 文件头 ---
    print("1) 文件头")
    check(data[:8] == b"%PDF-1.4", "版本头 %PDF-1.4", errors)
    # 头 9 字节是 "%PDF-1.4\n"，紧接着的注释行才是二进制标记：% + e2 e3 cf d3
    check(data[9:14] == b"%\xe2\xe3\xcf\xd3", "二进制标记字节正确", errors)

    # --- 2. startxref ---
    print("\n2) startxref 指向")
    m = re.search(rb"startxref\s+(\d+)\s+%%EOF", data)
    check(m is not None, "存在 startxref / %%EOF", errors)
    if not m:
        return report(errors)
    xref_off = int(m.group(1))
    check(
        0 <= xref_off < len(data) and data[xref_off : xref_off + 4] == b"xref",
        f"startxref({xref_off}) 指向 xref 关键字",
        errors,
    )

    # --- 3. xref 表 ---
    print("\n3) xref 表")
    xref_block = data[xref_off:]
    hm = re.match(rb"xref\s+0\s+(\d+)\s+", xref_block)
    check(hm is not None, "xref 子段声明 '0 <count>'", errors)
    if not hm:
        return report(errors)
    count = int(hm.group(1))
    entries_start = hm.end()

    # 每条记录固定 20 字节
    entries = []
    for i in range(count):
        rec = xref_block[entries_start + i * 20 : entries_start + (i + 1) * 20]
        if len(rec) != 20:
            check(False, f"第 {i} 条 xref 记录不足 20 字节", errors)
            return report(errors)
        entries.append(rec)
    print(f"  [OK]   共 {count} 条 xref 记录，每条 20 字节")

    check(entries[0].startswith(b"0000000000 65535 f"), "对象 0 是空闲条目", errors)

    # --- 4. 逐条核对偏移 ---
    print("\n4) 对象偏移核对")
    ok_all = True
    for obj_id in range(1, count):
        off = int(entries[obj_id][:10])
        expect = f"{obj_id} 0 obj".encode()
        actual = data[off : off + len(expect)]
        if actual != expect:
            ok_all = False
            errors.append(f"对象 {obj_id} 偏移错误：期望位置是 {actual!r}")
    check(ok_all, f"{count - 1} 个对象的偏移全部精确", errors)

    # --- 5. trailer ---
    print("\n5) trailer")
    tm = re.search(rb"trailer\s*<<\s*/Size\s+(\d+)\s*/Root\s+(\d+)\s+0\s+R", data[xref_off:])
    check(tm is not None, "trailer 含 /Size 与 /Root", errors)
    if tm:
        size = int(tm.group(1))
        check(size == count, f"/Size({size}) 与 xref 条目数({count})一致", errors)
        root = int(tm.group(2))
        check(root == 1, f"/Root 指向对象 {root}", errors)

    # --- 6. 抽取并校验嵌入的 JPEG ---
    print("\n6) 嵌入图片流")
    img_re = re.compile(
        rb"(\d+) 0 obj\s*<<[^>]*?/Subtype\s*/Image\b(.*?)>>\s*stream\r?\n", re.DOTALL
    )
    found = 0
    for match in img_re.finditer(data):
        obj_id = int(match.group(1))
        header = match.group(2)
        lm = re.search(rb"/Length\s+(\d+)", header)
        fm = re.search(rb"/Filter\s*/(\w+)", header)
        wm = re.search(rb"/Width\s+(\d+)", header)
        hmm = re.search(rb"/Height\s+(\d+)", header)
        if not (lm and fm):
            errors.append(f"对象 {obj_id} 缺少 /Length 或 /Filter")
            continue
        length = int(lm.group(1))
        stream = data[match.end() : match.end() + length]
        good = len(stream) == length and stream[:3] == b"\xff\xd8\xff" and stream[-2:] == b"\xff\xd9"
        found += 1
        w = wm.group(1).decode() if wm else "?"
        h = hmm.group(1).decode() if hmm else "?"
        check(
            good,
            f"对象 {obj_id}: {fm.group(1).decode()} {w}x{h} {length} 字节，JPEG 首尾标记完整",
            errors,
        )
    check(found >= 1, f"共检出 {found} 个图片流", errors)

    # --- 7. 页面树 ---
    print("\n7) 页面树")
    pm = re.search(rb"/Type\s*/Pages\s*/Kids\s*\[(.*?)\]\s*/Count\s+(\d+)", data, re.DOTALL)
    check(pm is not None, "存在 /Pages 与 /Kids", errors)
    if pm:
        kids = re.findall(rb"(\d+)\s+0\s+R", pm.group(1))
        n = int(pm.group(2))
        check(len(kids) == n, f"/Count({n}) 与 /Kids 数量({len(kids)})一致", errors)
        page_count = len(re.findall(rb"/Type\s*/Page[^s]", data))
        check(page_count == n, f"实际 Page 对象数({page_count}) 与 /Count({n})一致", errors)

    return report(errors)


def report(errors):
    print()
    if errors:
        print(f"✗ 校验未通过，{len(errors)} 个问题：")
        for e in errors:
            print(f"   - {e}")
        return 1
    print("✓ 全部通过，PDF 结构合法")
    return 0


if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "output", "sample.pdf"
    )
    sys.exit(main(target))
