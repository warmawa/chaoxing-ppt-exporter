#!/usr/bin/env bash
#
# ui-render.test.sh — 面板真实渲染验证（需要本机装了 Edge/Chrome，没有就自动跳过）
#
# 为什么需要它：ui.js 里定位一旦写错作用域（比如把 position:fixed 写进
# shadow 内部的选择器），静态扫描发现不了——那不是语法错误，是"规则压根
# 匹配不到 host 元素"。唯一的办法是真的渲染一遍，量一下 boundingRect。
#
# 出过的事故：面板 position 算出来是 static、top 是 8000，沉在被撑高的
# 课件页最底部，用户在页面上完全看不到它，关页面时才闪一下。
#
# 运行：bash test/ui-render.test.sh

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UI="$ROOT/extension/src/lib/ui.js"
OUT="$ROOT/test/output"
PAGE="$OUT/panel-render.html"
DOM="$OUT/panel-render.dom.txt"

BROWSER=""
for c in \
  "/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" \
  "/c/Program Files/Microsoft/Edge/Application/msedge.exe" \
  "/c/Program Files/Google/Chrome/Application/chrome.exe" \
  "/c/Program Files (x86)/Google/Chrome/Application/chrome.exe" \
  "/usr/bin/google-chrome" \
  "/usr/bin/chromium" \
  "/usr/bin/chromium-browser"; do
  [ -f "$c" ] && BROWSER="$c" && break
done

if [ -z "$BROWSER" ]; then
  echo "未找到 Edge/Chrome，跳过渲染验证（其余测试不受影响）"
  exit 0
fi

mkdir -p "$OUT"

# 造一个"被撑高的课件页"：body 8000px，正是出事故的那种环境
{
  echo '<!DOCTYPE html><html><head><meta charset="utf-8">'
  echo '<style>body{margin:0;font-family:sans-serif}.fake{height:8000px;background:#fff}</style>'
  echo '</head><body><div class="fake"></div>'
  echo '<script>'
  cat "$UI"
  echo '</script>'
  cat <<'INLINE'
<script>
setTimeout(function () {
  var out = {};
  try {
    var p = new window.CXPanel(null, {});
    var r = p.host.getBoundingClientRect();
    var cs = getComputedStyle(p.host);
    out = {
      top: Math.round(r.top), left: Math.round(r.left),
      w: Math.round(r.width), h: Math.round(r.height),
      position: cs.position, zIndex: cs.zIndex,
      display: cs.display, visibility: cs.visibility,
      inViewport: (r.height > 0 && r.top >= 0 && r.top < window.innerHeight &&
                   r.left >= 0 && r.left < window.innerWidth)
    };
  } catch (e) { out = { error: String(e && e.message) }; }
  var pre = document.createElement('pre');
  pre.id = 'cx-result';
  pre.textContent = 'CXRESULT ' + JSON.stringify(out);
  document.body.appendChild(pre);
}, 400);
</script></body></html>
INLINE
} > "$PAGE"

# 用独立的 user-data-dir：用户自己开着浏览器时，共用配置目录会让
# headless 进程直接 EBUSY 起不来
PROFILE="$(mktemp -d 2>/dev/null || echo "$OUT/render-profile")"
URL="file:///$(cygpath -m "$PAGE" 2>/dev/null || echo "$PAGE")"

"$BROWSER" --headless=new --disable-gpu --no-sandbox --no-first-run \
  --user-data-dir="$PROFILE" --virtual-time-budget=4000 --window-size=1000,600 \
  --dump-dom "$URL" > "$DOM" 2>/dev/null

rm -rf "$PROFILE" 2>/dev/null

RESULT="$(grep -o '<pre id="cx-result">CXRESULT [^<]*' "$DOM" 2>/dev/null | head -1 | sed 's/.*CXRESULT //')"

echo "浏览器：$(basename "$BROWSER")"
echo

OK=0
FAIL=0
assert() { # 名称 是否通过 详情
  if [ "$2" = "1" ]; then
    echo "  ok    $1"
    OK=$((OK + 1))
  else
    echo "  FAIL  $1${3:+ — $3}"
    FAIL=$((FAIL + 1))
  fi
}

has() { case "$RESULT" in *"$1"*) echo 1 ;; *) echo 0 ;; esac; }

assert "渲染脚本执行成功" "$([ -n "$RESULT" ] && echo 1 || echo 0)" "页面里没找到测量结果，浏览器可能没起来"

if [ -n "$RESULT" ]; then
  assert "面板 position 是 fixed" "$(has '"position":"fixed"')" "$RESULT"
  assert "面板层级取到最大值" "$(has '"zIndex":"2147483647"')" "$RESULT"
  assert "面板可见（display / visibility）" \
    "$(has '"display":"block"')" "$RESULT"
  assert "面板落在视口内（沉到页底不算）" "$(has '"inViewport":true')" "$RESULT"

  TOP="$(echo "$RESULT" | sed -n 's/.*"top":\(-\{0,1\}[0-9]*\).*/\1/p')"
  if [ -n "$TOP" ] && [ "$TOP" -ge 0 ] && [ "$TOP" -lt 200 ]; then
    assert "面板贴着顶部" 1
  else
    assert "面板贴着顶部" 0 "top=$TOP"
  fi

  W="$(echo "$RESULT" | sed -n 's/.*"w":\([0-9]*\).*/\1/p')"
  if [ -n "$W" ] && [ "$W" -gt 300 ]; then
    assert "面板有实际尺寸" 1
  else
    assert "面板有实际尺寸" 0 "w=$W"
  fi
fi

echo
echo "=============================================="
if [ "$FAIL" -gt 0 ]; then
  echo "通过 $OK 项，失败 $FAIL 项"
  exit 1
fi
echo "渲染验证通过（$OK 项）"
