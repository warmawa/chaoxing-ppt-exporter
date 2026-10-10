#!/usr/bin/env bash
#
# 一键发布到 GitHub。
#
# 前置条件：先执行 `gh auth login` 完成登录（浏览器授权，只需做一次）。
# 用法：bash tools/publish.sh
#
set -euo pipefail

REPO_NAME="chaoxing-ppt-exporter"
# 想改成私有仓库，把下一行换成 VISIBILITY="--private"
VISIBILITY="--public"

# gh 装在 "C:\Program Files\GitHub CLI"，Git Bash 的默认 PATH 里常常没有
if ! command -v gh >/dev/null 2>&1; then
  export PATH="$PATH:/c/Program Files/GitHub CLI"
fi

echo "----------------------------------------"
echo " 学习通课件导出器 · 发布到 GitHub"
echo "----------------------------------------"
echo

# --- 1. 检查 gh 与登录状态 ---
if ! command -v gh >/dev/null 2>&1; then
  echo "✗ 找不到 gh。请先安装 GitHub CLI："
  echo "    winget install --id GitHub.cli -e"
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "✗ 还没登录 GitHub。请先执行："
  echo "    gh auth login"
  echo "  然后重新运行本脚本。"
  exit 1
fi

echo "✓ GitHub CLI 已就绪"

# --- 2. 取身份 ---
USER_NAME="$(gh api user --jq .login)"
USER_ID="$(gh api user --jq .id)"
USER_EMAIL="$(gh api user --jq '.email // ""')"

# 用户在 GitHub 里隐藏了邮箱时，用官方的 noreply 地址
if [ -z "$USER_EMAIL" ]; then
  USER_EMAIL="${USER_ID}+${USER_NAME}@users.noreply.github.com"
fi

echo "✓ 已登录为 ${USER_NAME} <${USER_EMAIL}>"
echo

# --- 3. 把占位符换成真实用户名 ---
echo "→ 替换项目里的 your-name 占位符"
for f in README.md extension/manifest.json userscript/chaoxing-ppt-exporter.user.js; do
  if [ -f "$f" ]; then
    sed -i "s|your-name|${USER_NAME}|g" "$f"
  fi
done
echo "✓ 完成"
echo

# --- 4. 配置 git 身份（只在没配过时写入，不覆盖已有设置）---
if [ -z "$(git config --global user.name 2>/dev/null || true)" ]; then
  git config --global user.name "$USER_NAME"
fi
if [ -z "$(git config --global user.email 2>/dev/null || true)" ]; then
  git config --global user.email "$USER_EMAIL"
fi
echo "✓ git 身份：$(git config user.name) <$(git config user.email)>"

# --- 5. 统一分支名 ---
git branch -M main 2>/dev/null || true

# --- 6. 提交 ---
echo
git add -A

if git diff --cached --quiet 2>/dev/null; then
  echo "✓ 没有需要提交的改动（可能已经提交过了）"
else
  git commit -F - <<'MSG'
feat: 学习通课件导出器 v1.0.0

把超星学习通章节里只能在线翻看的 PPT 课件导出为 PDF 或下载原始文件。

- 浏览器扩展（Chrome MV3）与油猴脚本双版本
- 三策略探测：原始文件直链 / PDF 直链 / 逐页图片合成，自动择优
- 图片请求监听，不依赖多变的 DOM 结构与 class 名
- 多层 iframe 穿透 + 后台去重，只弹一个操作面板
- 零依赖 PDF 生成器，JPEG 以 DCTDecode 原样嵌入，画质无损
- 导出前自动滚动触发懒加载，并发下载 + 失败重试
MSG
  echo "✓ 提交完成"
fi

# --- 7. 创建远程仓库并推送 ---
echo
if git remote get-url origin >/dev/null 2>&1; then
  echo "→ remote origin 已存在，直接推送"
  git push -u origin main
else
  if gh repo view "$REPO_NAME" >/dev/null 2>&1; then
    echo "→ GitHub 上已存在同名仓库，改用 gh 自动关联"
    gh repo create "$REPO_NAME" "$VISIBILITY" --source=. --remote=origin --push 2>/dev/null \
      || git remote add origin "https://github.com/${USER_NAME}/${REPO_NAME}.git"
    git push -u origin main
  else
    echo "→ 创建仓库 ${REPO_NAME} 并推送"
    gh repo create "$REPO_NAME" "$VISIBILITY" --source=. --remote=origin --push
  fi
fi

echo
echo "----------------------------------------"
echo " 发布完成"
echo " 仓库：https://github.com/${USER_NAME}/${REPO_NAME}"
echo
echo " 建议紧接着做的两件事："
echo "   1. 在仓库页面填一下 About 的描述和 topic（chaoxing / 学习通 / ppt）"
echo "   2. 到 Releases 上传 extension 打包好的 zip，方便别人一键安装："
echo "        python tools/package.py"
echo "----------------------------------------"
