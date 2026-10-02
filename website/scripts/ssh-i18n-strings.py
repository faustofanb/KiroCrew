#!/usr/bin/env python3
"""Inject apps.ssh catalog subtree into every locale (same policy as before)."""
from __future__ import annotations

import json
from pathlib import Path

LOCALES = Path('src/i18n/locales')

S = {
  'title': ('SSH', 'SSH'),
  'tab.connections': ('连接', 'Connections'),
  'tab.keys': ('密钥', 'Keys'),
  'tab.exec': ('执行', 'Exec'),
  'tab.terminal': ('终端', 'Terminal'),
  'tab.files': ('文件', 'Files'),
  'policyHint': ('仅密钥认证 · 不存储密码 · host key 首见即记录（accept-new）', 'key-only auth · no passwords stored · accept-new host keys'),
  'conn.add': ('添加连接', 'Add connection'),
  'conn.empty': ('尚无连接——右侧添加一台主机', 'No connections yet — add a host on the right'),
  'conn.test': ('测试', 'Test'),
  'conn.noPassword': ('仅支持密钥认证：密码永不被保存。可选指定 IdentityFile（~/.ssh/id_ed25519）。', 'Key auth only: passwords are never stored. Optionally pin an IdentityFile (~/.ssh/id_ed25519).'),
  'conn.field_name': ('名称（可选）', 'name (optional)'),
  'conn.field_host': ('主机 host *', 'host *'),
  'conn.field_port': ('端口', 'port'),
  'conn.field_user': ('用户', 'user'),
  'conn.field_identityFile': ('IdentityFile', 'IdentityFile'),
  'keys.title': ('~/.ssh 公钥', '~/.ssh public keys'),
  'keys.empty': ('未找到 *.pub', 'no *.pub found'),
  'keys.pubOnly': ('仅公钥', 'pub only'),
  'agent.title': ('ssh-agent', 'ssh-agent'),
  'agent.running': ('运行中', 'running'),
  'agent.notRunning': ('不可用', 'not reachable'),
  'knownHosts.title': ('known_hosts', 'known_hosts'),
  'knownHosts.truncated': ('（列表过长已截断）', '(list truncated)'),
  'exec.placeholder': ('远程命令…', 'remote command…'),
  'exec.run': ('执行', 'Run'),
  'exec.empty': ('输出将在此流式显示（30s 超时，输出有界）', 'output streams here (30s timeout, bounded)'),
  'exec.history': ('历史', 'History'),
  'exec.noHistory': ('暂无历史', 'no history yet'),
  'term.open': ('打开终端', 'Open terminal'),
  'term.close': ('关闭', 'Close'),
  'term.closed': ('会话已关闭', 'session closed'),
  'term.error': ('终端连接失败', 'terminal connection failed'),
  'term.hint': ('xterm.js ↔ websocket ↔ ssh -tt', 'xterm.js ↔ websocket ↔ ssh -tt'),
  'term.pickFirst': ('选择连接后打开交互终端', 'Pick a connection to open an interactive terminal'),
  'files.refresh': ('刷新', 'refresh'),
  'files.upload': ('上传', 'Upload'),
  'files.empty': ('空目录', 'empty directory'),
  'files.name': ('名称', 'name'),
  'files.size': ('大小', 'size'),
  'files.mtime': ('修改时间', 'modified'),
  'files.owner': ('属主', 'owner'),
  'files.rename': ('重命名', 'rename'),
  'files.newName': ('新名称', 'new name'),
  'files.rmConfirm': ('删除 {{name}}？', 'Delete {{name}}?'),
  'files.mkdirPlaceholder': ('新建目录名，回车创建…', 'new directory name, Enter…'),
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
        idx = 0 if f.name == 'zh-CN.json' else 1
        data = json.loads(f.read_text(encoding='utf-8'))
        data.setdefault('apps', {})['ssh'] = nest({k: v[idx] for k, v in S.items()})
        f.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        print(f'{f.name}: {len(S)}')
    manual = LOCALES / 'en.manual.json'
    data = json.loads(manual.read_text(encoding='utf-8'))
    data.setdefault('apps', {})['ssh'] = nest({k: v[1] for k, v in S.items()})
    manual.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'en.manual.json: {len(S)}')


if __name__ == '__main__':
    main()
