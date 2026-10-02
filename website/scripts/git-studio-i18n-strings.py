#!/usr/bin/env python3
"""Inject the apps.gitStudio catalog subtree into every locale file.

zh-CN carries authored Chinese; every other language gets the English value
(progressive translation — parity tests only require key presence). English
itself goes into en.manual.json, the hand-authored half of the English
catalog, because these strings have no source literal for the codemod to
extract.

Re-run safe: the subtree is replaced wholesale.
"""

from __future__ import annotations

import json
from pathlib import Path

LOCALES = Path("src/i18n/locales")

# key -> (zh-CN, en); {{var}} keeps i18next interpolation
S = {
    "title": ("Git Studio", "Git Studio"),
    "common.loading": ("加载中…", "Loading…"),
    "common.empty": ("暂无内容", "Nothing here yet"),
    "common.error": ("出错了", "Something went wrong"),
    "common.cancel": ("取消", "Cancel"),
    "common.confirm": ("确认", "Confirm"),
    "common.done": ("完成", "Done"),
    "repos.add": ("添加仓库", "Add repository"),
    "repos.addPlaceholder": ("仓库绝对路径…", "Absolute repository path…"),
    "repos.empty": ("尚未添加仓库，输入路径开始", "No repositories yet — add one above"),
    "repos.remove": ("从列表移除", "Remove from list"),
    "graph.merge": ("合并", "merge"),
    "graph.empty": ("该分支暂无提交", "No commits on this branch"),
    "graph.end": ("已到底", "end"),
    "graph.loadingMore": ("加载更多提交…", "loading more commits…"),
    "graph.capped": ("图已按上限 {{cap}} 条截断", "graph truncated at cap {{cap}}"),
    "graph.searchPlaceholder": ("搜索提交…", "search commits…"),
    "graph.firstParentHint": ("仅沿第一父提交（压平合并）", "first-parent only (flattens merges)"),
    "workdir.title": ("工作目录", "Working directory"),
    "workdir.staged": ("已暂存", "staged"),
    "workdir.unstaged": ("未暂存", "unstaged"),
    "workdir.untracked": ("未跟踪", "untracked"),
    "workdir.conflicted": ("冲突", "conflicts"),
    "workdir.clean": ("工作目录干净", "Working directory clean"),
    "workdir.stage": ("暂存", "Stage"),
    "workdir.unstage": ("反暂存", "Unstage"),
    "workdir.discard": ("丢弃", "Discard"),
    "workdir.blame": ("逐行追溯", "Blame"),
    "workdir.blameShort": ("追溯", "Blame"),
    "workdir.history": ("文件历史", "File history"),
    "workdir.all": ("全部", "all"),
    "workdir.commit": ("提交", "Commit"),
    "workdir.commitPlaceholder": ("提交信息… (⌘+Enter)", "Commit message… (⌘+Enter)"),
    "workdir.amend": ("修正", "Amend"),
    "workdir.amendHint": (
        "追加到上一次提交（复用其信息）",
        "amend the last commit, reusing its message",
    ),
    "view.commit": ("提交", "Commit"),
    "view.file": ("文件", "File"),
    "view.blame": ("追溯", "Blame"),
    "view.history": ("历史", "History"),
    "view.stash": ("贮藏", "Stash"),
    "view.conflict": ("冲突", "Conflicts"),
    "view.rebase": ("变基", "Rebase"),
    "view.search": ("搜索", "Search"),
    "view.noneHint": ("选择提交或文件查看详情", "Select a commit or file to see details"),
    "view.pickTargetFirst": (
        "先在图或列表中选择目标",
        "Pick a target in the graph or a list first",
    ),
    "diff.noChanges": ("无差异", "No changes"),
    "diff.binary": ("二进制文件不展示内容差异", "Binary file — content diff not shown"),
    "diff.sbs": ("并排", "side-by-side"),
    "diff.sbsHint": ("并排 / 上下切换", "toggle side-by-side / unified"),
    "diff.wordDiff": ("词级", "word-diff"),
    "diff.wsHint": ("空白差异处理", "whitespace handling"),
    "diff.wsNone": ("精确空白", "exact whitespace"),
    "diff.wsEol": ("忽略行尾", "ignore EOL"),
    "diff.wsSpace": ("忽略空白量", "ignore space change"),
    "diff.wsAll": ("忽略全部空白", "ignore all whitespace"),
    "diff.stageHunk": ("暂存此块", "stage hunk"),
    "diff.unstageHunk": ("反暂存此块", "unstage hunk"),
    "diff.stageLine": ("暂存此行", "stage line"),
    "diff.unstageLine": ("反暂存此行", "unstage line"),
    "diff.stageSelection": ("暂存所选 ({{n}})", "stage selection ({{n}})"),
    "diff.unstageSelection": ("反暂存所选 ({{n}})", "unstage selection ({{n}})"),
    "diff.truncated": (
        "仅显示前 {{shown}} / {{total}} 行",
        "showing first {{shown}} of {{total}} lines",
    ),
    "branch.tab_branches": ("分支", "Branches"),
    "branch.tab_tags": ("标签", "Tags"),
    "branch.tab_remotes": ("远程", "Remotes"),
    "branch.newPlaceholder": ("新分支名，回车创建…", "new branch name, Enter to create…"),
    "branch.noUpstream": ("无上游", "no upstream"),
    "branch.gone": ("上游已消失", "upstream gone"),
    "branch.delete": ("删除分支", "delete branch"),
    "branch.forceDelete": ("强制删除（丢弃未合并提交）", "force delete (drops unmerged commits)"),
    "branch.deleteTitle": ("删除分支 {{name}}", "Delete branch {{name}}"),
    "branch.deleteBody": (
        "分支 {{name}} 将被删除。未合并的提交仍会保留在对象库中一段时间，但不再被引用。",
        "Branch {{name}} will be deleted. Unmerged commits stay in the object store a while, unreferenced.",
    ),
    "branch.forceDeleteTitle": ("强制删除分支 {{name}}", "Force-delete branch {{name}}"),
    "branch.forceDeleteBody": (
        "分支 {{name}} 含未合并提交，强制删除后这些提交将不可达。确定继续？",
        "Branch {{name}} has unmerged commits; force-deleting makes them unreachable. Continue?",
    ),
    "branch.mergeInto": ("合并进当前分支 {{current}}", "merge into current {{current}}"),
    "branch.rebaseOnto": ("变基到 {{name}}", "rebase onto {{name}}"),
    "tag.newPlaceholder": ("新标签名，回车创建…", "new tag name, Enter to create…"),
    "tag.empty": ("无标签", "No tags"),
    "tag.deleteTitle": ("删除标签 {{name}}", "Delete tag {{name}}"),
    "tag.deleteBody": (
        "标签 {{name}} 将从本仓库删除（不影响远程）。",
        "Tag {{name}} will be deleted locally (remote untouched).",
    ),
    "remote.empty": ("无远程", "No remotes"),
    "remote.add": ("添加", "Add"),
    "remote.added": ("远程 {{name}} 已添加", "remote {{name}} added"),
    "remote.name": ("名称", "name"),
    "remote.url": ("URL", "URL"),
    "remote.prune": ("清理", "prune"),
    "remote.delete": ("移除", "remove"),
    "remote.deleteTitle": ("移除远程 {{name}}", "Remove remote {{name}}"),
    "remote.deleteBody": (
        "移除远程 {{name}} 及其远程跟踪引用。远程仓库本身不受影响。",
        "Removes remote {{name}} and its remote-tracking refs. The remote repository itself is untouched.",
    ),
    "network.fetch": ("拉取", "Fetch"),
    "network.pull": ("拉回", "Pull"),
    "network.push": ("推送", "Push"),
    "network.force": ("强制", "force"),
    "network.forceHint": (
        "默认使用 --force-with-lease；勾选后才真正 --force",
        "default is --force-with-lease; tick to truly --force",
    ),
    "network.ffOnly": ("仅快进", "ff-only"),
    "network.cancel": ("取消操作", "cancel operation"),
    "network.cancelling": ("正在取消…", "cancelling…"),
    "stash.title": ("贮藏", "Stash"),
    "stash.empty": ("无贮藏", "No stashes"),
    "stash.push": ("贮藏", "Stash"),
    "stash.pushed": ("已贮藏", "stashed"),
    "stash.apply": ("应用", "apply"),
    "stash.applied": ("已应用", "applied"),
    "stash.pop": ("弹出", "pop"),
    "stash.popped": ("已弹出", "popped"),
    "stash.dropTitle": ("丢弃贮藏", "Drop stash"),
    "stash.dropBody": (
        "丢弃 {{ref}}？内容将不可恢复。",
        "Drop {{ref}}? Its content cannot be recovered.",
    ),
    "stash.dropped": ("已丢弃", "dropped"),
    "stash.messagePlaceholder": ("贮藏说明（可选）", "stash message (optional)"),
    "stash.includeUntracked": ("含未跟踪文件", "include untracked"),
    "stash.stagedOnly": ("仅暂存区", "staged only"),
    "stash.branchPlaceholder": ("从贮藏创建分支…", "branch name from stash…"),
    "stash.branchFrom": ("建分支", "branch"),
    "stash.branched": ("已从贮藏创建分支", "branched from stash"),
    "stash.selectHint": ("选择一条贮藏查看差异", "Select a stash to preview"),
    "conflict.title": ("冲突解决", "Merge conflicts"),
    "conflict.none": ("没有需要解决的冲突", "No conflicts to resolve"),
    "conflict.base": ("共同祖先", "base"),
    "conflict.ours": ("本方 (ours)", "ours"),
    "conflict.theirs": ("对方 (theirs)", "theirs"),
    "conflict.both": ("两者都保留", "keep both"),
    "conflict.choose": ("选用", "use this"),
    "conflict.empty": ("（空）", "(empty)"),
    "conflict.showBase": ("祖先", "base"),
    "conflict.takeOurs": ("整体用本方", "take ours"),
    "conflict.takeTheirs": ("整体用对方", "take theirs"),
    "conflict.markResolved": ("标记已解决", "mark resolved"),
    "conflict.resolved": ("{{path}} 已标记解决", "{{path}} marked resolved"),
    "conflict.unresolved": ("还有 {{n}} 处冲突未决定", "{{n}} conflict block(s) still undecided"),
    "conflict.noMarkers": (
        "文件中没有冲突标记——可能已在别处解决",
        "No conflict markers in the file — likely already resolved elsewhere",
    ),
    "rebase.title": ("交互式变基", "Interactive rebase"),
    "rebase.inProgress": ("变基进行中", "rebase in progress"),
    "rebase.doneCount": ("已完成", "done"),
    "rebase.todoCount": ("待办", "todo"),
    "rebase.stoppedAt": ("停在", "stopped at"),
    "rebase.conflictFiles": ("冲突文件", "conflicted files"),
    "rebase.resolveHint": (
        "在「冲突」页解决后回到这里点继续",
        "resolve them in the Conflicts view, then Continue here",
    ),
    "rebase.continue": ("继续", "Continue"),
    "rebase.skip": ("跳过", "Skip"),
    "rebase.abort": ("中止", "Abort"),
    "rebase.rewordCurrent": ("改写当前提交信息", "reword current commit"),
    "rebase.amend": ("改写", "amend"),
    "rebase.doneList": ("已完成步骤", "done"),
    "rebase.todoList": ("剩余步骤", "remaining"),
    "rebase.upstream": ("上游", "upstream"),
    "rebase.preview": ("预览 TODO", "preview todo"),
    "rebase.noPreview": ("选择上游后点「预览 TODO」", "pick an upstream and press preview"),
    "rebase.todoEditor": ("TODO 编辑器", "todo editor"),
    "rebase.command": ("操作", "command"),
    "rebase.moveUp": ("上移", "move up"),
    "rebase.moveDown": ("下移", "move down"),
    "rebase.start": ("按此 TODO 开始变基", "start rebase with this todo"),
    "rebase.startPlain": ("普通变基", "plain rebase"),
    "rebase.dragHint": ("可拖拽排序行", "rows are draggable"),
    "rebase.conflictStopped": (
        "变基停在冲突处——去「冲突」页解决",
        "rebase stopped on a conflict — resolve it in the Conflicts view",
    ),
    "rebase.done": ("变基完成", "rebase finished"),
    "blame.lines": ("行", "lines"),
    "blame.empty": ("无法追溯", "nothing to blame"),
    "history.followRenames": ("跟随重命名", "follow renames"),
    "history.empty": ("无历史", "No history"),
    "search.all": ("全部", "all"),
    "search.message": ("提交信息", "message"),
    "search.author": ("作者", "author"),
    "search.empty": ("无匹配结果", "no matches"),
    "banner.mergeInProgress": ("合并待提交", "merge awaiting commit"),
    "banner.finishMerge": ("完成合并", "finish merge"),
    "banner.abortMerge": ("中止合并", "abort merge"),
    "banner.mergeConflicts": ("合并冲突：{{n}} 个文件", "merge conflicts: {{n}} file(s)"),
    "banner.openResolver": ("打开冲突解决器", "open resolver"),
    "banner.sequencerInProgress": ("{{op}} 进行中", "{{op}} in progress"),
    "banner.sequencerConflicts": ("{{op}} 停在冲突处", "{{op}} stopped on conflicts"),
    "banner.continue": ("继续", "continue"),
    "banner.abort": ("中止", "abort"),
    "notice.repoAdded": ("仓库已添加", "repository added"),
    "notice.repoRegistered": ("仓库已在列表中", "repository already registered"),
    "notice.staged": ("已暂存", "staged"),
    "notice.unstaged": ("已反暂存", "unstaged"),
    "notice.stagedAll": ("已全部暂存", "staged all"),
    "notice.unstagedAll": ("已全部反暂存", "unstaged all"),
    "notice.stagedLines": ("所选行已暂存", "selected lines staged"),
    "notice.unstagedLines": ("所选行已反暂存", "selected lines unstaged"),
    "notice.committed": ("已提交", "committed"),
    "notice.checkedOut": ("已检出", "checked out"),
    "notice.cherryPicked": ("已拣选", "cherry-picked"),
    "notice.reverted": ("已还原", "reverted"),
    "notice.mergeCommitted": ("合并已提交", "merge committed"),
    "notice.continued": ("已继续", "continued"),
    "palette.placeholder": ("输入命令…", "type a command…"),
    "palette.none": ("无匹配命令", "no matching commands"),
    "palette.refresh": ("刷新全部", "refresh everything"),
    "palette.openStash": ("打开贮藏面板", "open stash"),
    "palette.openRebase": ("打开变基编辑器", "open rebase editor"),
    "palette.stageAll": ("暂存全部更改", "stage all changes"),
    "palette.unstageAll": ("反暂存全部", "unstage all"),
    "palette.stashPush": ("贮藏当前更改", "stash working changes"),
    "palette.cherryPick": ("拣选选中提交", "cherry-pick selected commit"),
    "palette.revert": ("还原选中提交", "revert selected commit"),
    "palette.resetSoft": ("软重置到选中提交", "reset (soft) to selected commit"),
    "palette.resetMixed": ("混合重置到选中提交", "reset (mixed) to selected commit"),
    "palette.resetHard": (
        "硬重置到选中提交（危险）",
        "reset (hard) to selected commit (dangerous)",
    ),
    "palette.checkoutCommit": ("检出选中提交（分离头）", "checkout selected commit (detached)"),
    "confirm.discardTitle": ("丢弃更改", "Discard changes"),
    "confirm.discardBody": (
        "丢弃 {{path}} 的未暂存/未跟踪更改？此操作不可恢复。",
        "Discard unstaged/untracked changes in {{path}}? This cannot be undone.",
    ),
    "confirm.resetTitle": ("{{mode}} 重置", "{{mode}} reset"),
    "confirm.resetBody": (
        "将当前分支重置到 {{sha}}（{{mode}}）。",
        "Reset the current branch to {{sha}} ({{mode}}).",
    ),
    "confirm.removeRepoTitle": ("移除仓库", "Remove repository"),
    "confirm.removeRepoBody": (
        "把 {{name}} 从 Git Studio 列表移除（不删除磁盘上的仓库）。",
        "Remove {{name}} from the Git Studio list (the repository on disk stays).",
    ),
    "confirm.abortMergeTitle": ("中止合并", "Abort merge"),
    "confirm.abortMergeBody": (
        "放弃本次合并，恢复到合并前状态。",
        "Abandon this merge and restore the pre-merge state.",
    ),
    "confirm.abortSequencerTitle": ("中止 {{op}}", "Abort {{op}}"),
    "confirm.abortSequencerBody": (
        "放弃进行中的 {{op}}，回到开始前的状态。",
        "Abandon the in-progress {{op}} and return to its starting state.",
    ),
}


def subtree(lang: str) -> dict:
    idx = 0 if lang in ("zh-CN", "zh") else 1
    return {k: v[idx] for k, v in S.items()}


def nest(flat: dict) -> dict:
    tree: dict = {}
    for k, v in flat.items():
        parts = k.split(".")
        node = tree
        for p in parts[:-1]:
            node = node.setdefault(p, {})
        node[parts[-1]] = v
    return tree


def inject(path: Path, lang: str) -> None:
    data = json.loads(path.read_text(encoding="utf-8"))
    apps = data.setdefault("apps", {})
    apps["gitStudio"] = nest(subtree(lang))
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"{path}: {len(S)} keys injected")


def main() -> None:
    for f in sorted(LOCALES.glob("*.json")):
        if f.name in ("en.json", "en-XA.json"):
            continue  # en.json is codemod-generated; en-XA is generated pseudolocale
        inject(f, "zh-CN" if f.name == "zh-CN.json" else "en")
    # English authored half
    manual = LOCALES / "en.manual.json"
    data = json.loads(manual.read_text(encoding="utf-8"))
    data.setdefault("apps", {})["gitStudio"] = nest(subtree("en"))
    manual.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"{manual}: {len(S)} keys injected (manual)")


if __name__ == "__main__":
    main()
