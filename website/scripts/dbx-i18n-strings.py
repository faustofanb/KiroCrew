#!/usr/bin/env python3
"""Inject the apps.dbx catalog subtree into every locale (same policy as
git-studio-i18n-strings.py: zh-CN authored, others get English)."""
from __future__ import annotations

import json
from pathlib import Path

LOCALES = Path('src/i18n/locales')

S = {
  'title': ('DBX 数据库', 'DBX Database'),
  'start': ('启动 dbx-web', 'Start dbx-web'),
  'stop': ('停止', 'Stop'),
  'restart': ('重启', 'Restart'),
  'reload': ('刷新', 'Reload'),
  'logs': ('日志', 'Logs'),
  'logTail': ('dbx-web 日志（有界尾部）', 'dbx-web log tail (bounded)'),
  'noLogs': ('（暂无日志输出）', '(no log output yet)'),
  'autoRestart': ('崩溃自动重启', 'auto-restart'),
  'autoRestartHint': ('进程崩溃后自动重新拉起（每分钟最多 3 次，超过则保持停止）', 'relaunch after a crash, max 3 per minute'),
  'state.checking': ('检测中…', 'checking…'),
  'state.running': ('运行中', 'running'),
  'state.starting': ('启动中', 'starting'),
  'state.stopped': ('已停止', 'stopped'),
  'state.foreign': ('端口被外部进程占用', 'port held by a foreign process'),
  'stoppedTitle': ('dbx-web 未运行', 'dbx-web is not running'),
  'stoppedBody': ('启动后可在内嵌的完整 Web UI 中使用查询编辑器、数据网格、ER 图与 Schema Diff。源码编译、无 Docker；数据目录 ~/.local/share/dbx-web。', 'Start it to use the full embedded web UI: query editor, data grid, ER diagram, schema diff. Built from source, no Docker; data lives under ~/.local/share/dbx-web.'),
  'setupHint': ('dbx-web 尚未设置访问密码——在下方界面完成一次初始设置即可（密码只属于 dbx-web）。', 'dbx-web has no password yet — complete the one-time setup in the UI below (the password belongs to dbx-web).'),
  'connections': ('连接', 'Connections'),
  'connectionsReadOnly': ('只读投影 · 凭据不可见', 'read-only projection · credentials never shown'),
  'loadingConnections': ('读取连接清单…', 'loading connections…'),
  'noConnections': ('暂无连接——在 dbx-web 界面中添加', 'no connections yet — add one in the dbx-web UI'),
  'ask': ('生成', 'Ask'),
  'askPlaceholder': ('用自然语言问数据库…', 'ask the database in natural language…'),
  'promptReady': ('AI 上下文已就绪（复制到聊天）', 'AI context ready (paste into chat)'),
  'copy': ('复制', 'Copy'),
}


def nest(flat: dict) -> dict:
    tree: dict = {}
    for k, v in flat.items():
        parts = k.split('.')
        node = tree
        for p in parts[:-1]:
            node = node.setdefault(p, {})
        node[parts[-1]] = v
    return tree


def main() -> None:
    for f in sorted(LOCALES.glob('*.json')):
        if f.name in ('en.json', 'en-XA.json'):
            continue
        lang = 'zh-CN' if f.name == 'zh-CN.json' else 'en'
        idx = 0 if lang == 'zh-CN' else 1
        data = json.loads(f.read_text(encoding='utf-8'))
        data.setdefault('apps', {})['dbx'] = nest({k: v[idx] for k, v in S.items()})
        f.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        print(f'{f}: {len(S)} keys')
    manual = LOCALES / 'en.manual.json'
    data = json.loads(manual.read_text(encoding='utf-8'))
    data.setdefault('apps', {})['dbx'] = nest({k: v[1] for k, v in S.items()})
    manual.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'{manual}: {len(S)} keys (manual)')


if __name__ == '__main__':
    main()
