#!/usr/bin/env python3
"""
打包扩展为可分发 zip。

zip 里放的是 extension/ 的**内容**而不是 extension/ 这个目录本身，
这样解压出来就是一个能直接"加载已解压的扩展程序"的文件夹。

用法：python tools/package.py
产出：dist/chaoxing-ppt-exporter-v<version>.zip
"""

import json
import os
import zipfile

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
EXT_DIR = os.path.join(ROOT, "extension")
DIST_DIR = os.path.join(ROOT, "dist")

# 这些不会被算进扩展包
EXCLUDE_DIRS = {"__pycache__", ".git"}
EXCLUDE_EXT = {".md", ".pyc", ".map"}


def main():
    with open(os.path.join(EXT_DIR, "manifest.json"), encoding="utf-8") as f:
        manifest = json.load(f)
    version = manifest["version"]
    name = manifest["name"]

    os.makedirs(DIST_DIR, exist_ok=True)
    out = os.path.join(DIST_DIR, f"chaoxing-ppt-exporter-v{version}.zip")

    count = 0
    total = 0
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for dirpath, dirnames, filenames in os.walk(EXT_DIR):
            dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS]
            for fn in filenames:
                if os.path.splitext(fn)[1].lower() in EXCLUDE_EXT:
                    continue
                full = os.path.join(dirpath, fn)
                # 用相对 extension/ 的路径，解压后即为扩展根
                arcname = os.path.relpath(full, EXT_DIR).replace(os.sep, "/")
                zf.write(full, arcname)
                size = os.path.getsize(full)
                total += size
                count += 1
                print(f"  + {arcname:<40} {size / 1024:>8.1f} KB")

    print(f"\n{name} v{version}")
    print(f"  文件数：{count}")
    print(f"  原始大小：{total / 1024:.1f} KB")
    print(f"  压缩后：{os.path.getsize(out) / 1024:.1f} KB")
    print(f"  产出：{out}")


if __name__ == "__main__":
    main()
