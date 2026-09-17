import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Goal, Pause, Play, Radar, Save as SaveIcon, Square, X, Zap } from 'lucide-react'
import { Popover, PopoverTrigger, PopoverContent } from './ui/popover'
import { Btn } from './ui'
import ErrorNotice from './ErrorNotice'
import { cronJobsQuery } from '../api/cronJobsQuery'
import { runBelongsToSlot } from '../apps/workflows/runModel'
import { loadGoalDraft, saveGoalDraft, type GoalDraft } from '../utils/goalDrafts'
import { DRAFT_SAVE_DEBOUNCE_MS } from '../utils/draftConstants'

import { i18nT } from '../i18n/t'
import { fmtTimeNumeric } from '../i18n/format'
import { type AutoNudgeLoop, cycleText as loopCycleText, nextCycle, nextCycleText, judgeReading, judgeVerdictTime, AUTONUDGE_LOOPS_QUERY_KEY } from './autoNudgeLoop'
export type { AutoNudgeLoop } from './autoNudgeLoop'

interface Props {
  slotKey: string
  loop: AutoNudgeLoop | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onChange: (loop: AutoNudgeLoop | null) => void
  /** Present when this editor is the popover's default view and a bounded monitor can still be armed. */
  onSetUpBoundedMonitor?: () => void
  /** Disable legacy-loop writes while leaving Stop available for stale state. Also renders the reason. */
  writeDisabled?: boolean
  /**
   * True when the slot's last turn ended interrupted (the composer is showing
   * Resume). The chip stops pulsing and turns warn-coloured: the loop is still
   * armed, but nothing is running until the user resumes or the next idle-timer
   * cycle fires, and a pulsing chip would claim active work for that whole gap.
   */
  interrupted?: boolean
  /** Shared composer trigger supplied by the structured-monitor compatibility shell. */
  trigger?: ReactNode
  /** Structured body supplied by that shell; omitted to render the legacy editor. */
  content?: ReactNode
}

/**
 * The kill-switch placeholder the server substitutes at FIRE time
 * (`render_nudge_message` in `dashboard/handlers/autonudge.py` replaces it with
 * the loop's `stop_sentinel_path`). It must travel to `/api/autonudge`
 * verbatim -- substituting it in the form would leave the server nothing to
 * replace -- so the textarea keeps the raw token and the help line under it
 * explains what the token becomes (#10458). `DEFAULT_MSG` below ends with this
 * exact spelling; a test pins that the template still carries it.
 */
export const STOP_FILE_TOKEN = '{{STOP_FILE}}'

/**
 * The service's `MANUAL_STOP_REASON` (`src/kiro_crew/autonudge.py`): the
 * `stopped_reason` a `PATCH active:false` records, and the one the revive logic
 * never auto-resumes. Spelled here because the frontend shares no constants
 * module with the service; `autoNudgeLoop.ts` lists the other codes.
 */
const MANUAL_STOP_REASON = 'manual'
/** The service's wall-clock-budget stop (`_timer`'s `runtime_budget`): measured
 *  from the record's `created_ts`, which a revive never resets, against
 *  `max_runtime_secs`, which this popover has no field for. */
const RUNTIME_BUDGET_STOP_REASON = 'runtime_budget'

/** The three editable fields, as every write of the form sends them. */
type LoopFields = { message: string; idle_secs: number; max_cycles: number }

const DEFAULT_MSG = `Your north star is in north_star.md, roadmap in roadmap.md, tasks in tasks.md. Pick the single highest-leverage next step toward the goal and execute it. Update tasks.md. Post a blocker ONCE if genuinely stuck. To halt the loop, create {{STOP_FILE}}`

/** One armed script cron owned by this chat slot. */
interface SlotWatch {
  id: string
  name: string
  schedule: string
  next_run_ts: number | null
}

export default function AutoNudgePopover({ slotKey, loop, open, onOpenChange, onChange, onSetUpBoundedMonitor, writeDisabled = false, interrupted = false, trigger, content }: Props) {
  // `||` (not `??`) is deliberate on the loop tier: it preserves the fallback
  // so a loop with idle_secs/max_cycles of 0 or an empty message still shows
  // the 60 / 0 / default template rather than a bare 0 / "".
  const [message, setMessage] = useState(() => loop?.message || DEFAULT_MSG)
  // Idle-seconds and max-cycles are held as RAW STRINGS while the popover is
  // open so every edit (including a fully-cleared field or a transient "") is
  // allowed as-typed. Coercing to a number on each keystroke would snap a
  // backspaced-to-empty field straight back to its default and prevent removing
  // the leading digit. The string is parsed
  // into a number only when the field commits (blur / save); an empty or
  // unparseable value falls back to the field default — 60 idle, 0 cycles.
  const [idleInput, setIdleInput] = useState(() => String(loop?.idle_secs || 60))
  const [maxCyclesInput, setMaxCyclesInput] = useState(() => String(loop?.max_cycles || 0))
  const [saving, setSaving] = useState(false)
  /* Two-step on every erase of a loop that is not running -- Stop on a paused
     loop, Stop on a stopped record. The erase is irreversible and sits beside
     the primary CTA, so one press asks and the second performs. */
  const [confirmClear, setConfirmClear] = useState(false)
  const [error, setError] = useState('')
  // Watches armed on this slot, read through the SHARED `cron-jobs` query rather
  // than a private fetch. That key is invalidated by the websocket hook, so a
  // watch deleted or paused elsewhere disappears from an open popover instead of
  // lingering until it is reopened -- and the request dedupes with the other
  // consumer of the same key. `enabled: open` keeps a zero-token watch from
  // costing a request on every chat render just to say "still nothing".
  const queryClient = useQueryClient()
  const { data: cronJobs, isError: watchesFailed, refetch: refetchWatches } = useQuery({
    ...cronJobsQuery,
    enabled: open && content === undefined,
  })

  const watches: SlotWatch[] = useMemo(() => {
    const rows: unknown[] = Array.isArray(cronJobs) ? cronJobs : []
    return rows
      .filter((j): j is Record<string, unknown> => !!j && typeof j === 'object')
      .filter(j => {
        // One ownership rule, one spelling. `runBelongsToSlot` already maps a
        // session_key onto a chat slot against the same backend convention
        // (`dashboard:<slotKey>`); a second inline predicate here would drift
        // from it the day that key format moves.
        if (!runBelongsToSlot(typeof j.session_key === 'string' ? j.session_key : '', slotKey)) {
          return false
        }
        // A watch is a SCRIPT cron: it runs a Python callable and never reaches a
        // model. A message-only cron on this slot is an ordinary reminder that
        // DOES wake the agent, so it does not belong under a heading that
        // promises zero tokens.
        return typeof j.script === 'string' && !!j.script && j.enabled !== false
      })
      .map(j => ({
        id: String(j.id ?? ''),
        name: String(j.name ?? ''),
        schedule: String(j.schedule ?? ''),
        next_run_ts: typeof j.next_run_ts === 'number' ? j.next_run_ts : null,
      }))
  }, [cronJobs, slotKey])

  const parseIdle = (s: string) => parseInt(s, 10) || 60
  const parseCycles = (s: string) => parseInt(s, 10) || 0

  // Only a genuine user edit should persist a draft. Seeding from the live loop
  // or restoring a remembered draft on open must NOT re-write the store (doing
  // so would reset the slot's TTL / LRU position on a mere view, and could
  // mirror a live loop's config into the user-draft store). `hasEdited` gates
  // the persist so it fires on real onChange edits only.
  const hasEdited = useRef(false)
  // Latest field values, kept current every render so the close-flush below
  // (which runs from a stable handler) can read them.
  const latest = useRef({ slotKey, message, idleInput, maxCyclesInput, loop })
  latest.current = { slotKey, message, idleInput, maxCyclesInput, loop }
  /* What the three fields held when the popover last SHOWED them to the user:
     the record they were seeded from on open, or the values the user's last
     write of the fields sent. `editedFields` measures against this, field by
     field, so "edited" means the USER changed that field since -- not that
     the record changed underneath. The distinction is the whole point: the
     fields seed on the open edge only and never re-sync, so a `monitor_update`
     or another tab's save that lands while the popover sits open is NOT in
     the form; a write that sent a field the user never touched would write
     that stale value back over the revision. Measured against the live record
     instead, that very case would read as an edit and clobber.
     Seeded from the RECORD on the first render, not only in the open-edge
     effect below: two things now render off `editedFields` -- the Trigger's
     label and whether Save shows on an inactive loop -- and a first render
     with no baseline would read every field as edited until the effect ran.
     With no loop the baseline is the remembered draft, which is a storage
     read, so that seed stays in the effect (nothing renders off it until it
     has run). */
  const seeded = useRef<LoopFields | null>(
    loop ? { message: loop.message || DEFAULT_MSG, idle_secs: loop.idle_secs || 60, max_cycles: loop.max_cycles || 0 } : null,
  )

  // Compute the draft to persist for the current field state, or null to drop
  // the slot: the blank / pristine-default case stores nothing so an emptied or
  // untouched popover never pins the template. (Only reached when no loop is
  // running — a live loop is authoritative and its config is never mirrored
  // into the user-draft store; persistence is skipped entirely while a loop is
  // present.)
  function draftToPersist(s: typeof latest.current): GoalDraft | null {
    const idleSecs = parseIdle(s.idleInput)
    const maxCycles = parseCycles(s.maxCyclesInput)
    const isPristineDefault = s.message === DEFAULT_MSG && idleSecs === 60 && maxCycles === 0
    return isPristineDefault ? null : { message: s.message, idleSecs, maxCycles }
  }

  /* A pending confirmation belongs to the record the reader was LOOKING at. The
     popover re-renders from websocket state without closing, so another tab can
     swap that record underneath it -- edit and restart the same loop id, then a
     cycle cap (max_cycles=1 fires once) stops it again -- and the primed press
     would erase a goal the confirmation never described. The intent guard does
     not catch it: the record is inactive at render AND at press, so the server
     sees no mismatch. Keyed on identity, state and the text itself, since the
     text is what the erase destroys and drafts are not persisted while a loop
     exists. */

  useEffect(() => {
    setConfirmClear(false)
  }, [loop?.id, loop?.active, loop?.message])

  // Seed/restore fields on each open (rising edge). A live loop is the
  // authoritative source; otherwise the last per-slot draft is restored.
  // One read seeds all three fields. Runs in an effect (not render) so the
  // render itself performs no storage read/write.
  useEffect(() => {
    if (!open) return
    hasEdited.current = false
    // Whatever error the previous open showed is stale on a fresh open.
    setError('')
    // A pending confirmation must not survive a close: reopening later would
    // put a primed erase under the next press.
    setConfirmClear(false)
    if (loop) {
      // `||` (not `??`) is deliberate: a loop with idle_secs/max_cycles of 0
      // or an empty message shows the 60 / 0 / default template.
      setMessage(loop.message || DEFAULT_MSG)
      setIdleInput(String(loop.idle_secs || 60))
      setMaxCyclesInput(String(loop.max_cycles || 0))
      // The same fallbacks, so a pristine form compares equal to what it shows.
      seeded.current = { message: loop.message || DEFAULT_MSG, idle_secs: loop.idle_secs || 60, max_cycles: loop.max_cycles || 0 }
    } else {
      const remembered = loadGoalDraft(slotKey)
      setMessage(remembered ? remembered.message : DEFAULT_MSG)
      setIdleInput(String(remembered ? remembered.idleSecs : 60))
      setMaxCyclesInput(String(remembered ? remembered.maxCycles : 0))
      seeded.current = remembered
        ? { message: remembered.message, idle_secs: remembered.idleSecs, max_cycles: remembered.maxCycles }
        : { message: DEFAULT_MSG, idle_secs: 60, max_cycles: 0 }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- open-edge seed only; loop/slotKey are read fresh each open
  }, [open])

  // Flush a pending debounced edit synchronously when the popover closes OR
  // unmounts while open, so edits within the last DRAFT_SAVE_DEBOUNCE_MS
  // window aren't lost. Effect cleanup covers both paths.
  useEffect(() => {
    if (!open) return
    return () => {
      if (!hasEdited.current || latest.current.loop) return
      saveGoalDraft(latest.current.slotKey, draftToPersist(latest.current))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stable cleanup reading the latest ref
  }, [open])

  // Persist edits per slot, debounced with the same DRAFT_SAVE_DEBOUNCE_MS as
  // chat drafts so a long goal doesn't drive a synchronous localStorage write on
  // every keystroke. Skips until the user actually edits a field (so opening the
  // popover or the open-restore setState above never writes).
  useEffect(() => {
    if (!open || !hasEdited.current || loop) return
    const timer = setTimeout(() => saveGoalDraft(slotKey, draftToPersist(latest.current)), DRAFT_SAVE_DEBOUNCE_MS)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `draftToPersist` is a pure transform of the ref snapshot it is handed, redeclared each render, so its identity carries no information the deps above miss. Depending on it would restart the debounce timer on every unrelated re-render — the coalescing this effect exists for.
  }, [open, slotKey, message, idleInput, maxCyclesInput, loop])

  /** A loop somebody PAUSED -- inactive, with the reason a manual pause records
   *  -- as opposed to one a bound spent (`cycle_cap`, `runtime_budget`,
   *  `approval_stalled`), a tool tombstoned (`autonudge_stop`), or one whose
   *  reason is unknown here. Only this state reads "Paused" and labels its Play
   *  "Resume loop"; everything else inactive reads "Stopped" and its Play reads
   *  "Start loop", with Stop becoming the erase of the retained record. Strict
   *  equality on purpose: an absent reason means "not known here", and the safe
   *  reading of unknown is the non-resumable one. */
  const pausedManually = !!loop && !loop.active && loop.stopped_reason === MANUAL_STOP_REASON

  /** Whether the timer would turn a revive from here away BEFORE the nudge --
   *  and, on a RUNNING loop, whether the next tick stops it on a bound. Play
   *  sends `active: true` and then fires, but the fire runs through the
   *  ordinary timer body, whose bound checks come first: a spent cycle cap
   *  (`cycle_count >= max_cycles`, cap 0 = none) or a spent wall-clock budget
   *  deactivates the loop again -- `cycle_cap` / `runtime_budget` -- and no
   *  nudge goes out. The budget has no field here (`max_runtime_secs` is
   *  measured from the record's creation, and neither is in this form), so a
   *  loop stopped on it has nothing to revive it with from this surface. Read
   *  off the record, not the stop reason, for the cap: a loop paused by hand
   *  with its count already at the cap meets the same check.
   *
   *  The cap is the RECORD's (`loop.max_cycles`), never the unsaved input: the
   *  field governs what the next write SENDS, not what the loop is bound by,
   *  and a cap typed below the count on an uncapped loop binds nothing until a
   *  write lands it. The input enters exactly once, for Play alone, and only
   *  to LIFT: Play writes the edited field on the way to the fire, so the
   *  moment the field holds a value the timer would let through -- above the
   *  count, or 0 -- the revive is one that fires, and Play is back. A typed cap
   *  that Play itself would spend is the service's call on that fire (it
   *  answers with the stopped record, and `boundReason` says why), the footing
   *  Trigger already has on a running loop.
   *
   *  Pause follows the record too, but only the BUDGET holds it. A running
   *  loop sits at its cap for a whole idle interval after the capping fire
   *  (the timer's cap check runs on the NEXT tick), and Pause is the one route
   *  to Stop on a running loop, so a Pause held there would leave the owner
   *  no working control for up to that interval. Nothing is lost by letting
   *  it through: the paused record still reads its bound off its own numbers
   *  (`capSpent` below is `cycle_count >= max_cycles`, not the reason string),
   *  so it comes back as "Paused · Cycle cap reached", and its Play stays held
   *  until the cap is raised. The budget is different: no field here clears
   *  it, so a pause over it could only hide it. The bound the surface cannot
   *  see -- a stop the frame has not yet delivered -- the service keeps by
   *  itself, and its answer (the record as it stands) is what `pause` hands
   *  up. */
  const capSpent = !!loop && loop.max_cycles > 0 && loop.cycle_count >= loop.max_cycles
  const budgetSpent = !!loop && loop.stopped_reason === RUNTIME_BUDGET_STOP_REASON
  const formCapLifts = !!loop && (parseCycles(maxCyclesInput) === 0 || parseCycles(maxCyclesInput) > loop.cycle_count)
  const pauseBlocked = budgetSpent
  const playBlocked = budgetSpent || (capSpent && !formCapLifts)

  /** The bound a loop is held by, named on the schedule line -- beside the
   *  status word of an inactive loop, whose Play the gate has disabled, and
   *  beside the countdown of a RUNNING loop that sits at its cap, whose next
   *  tick will stop it: a disabled control, or a countdown that will not fire
   *  a nudge, is not left with nothing said. Follows the record like the gate
   *  does: the budget by its reason, the cap by the record's own numbers (a
   *  cap another writer raised since names no bound, because none holds it
   *  any more), and it stays while the record stands, whatever the form
   *  holds, because the line is about the loop, not the field. */
  const boundReason = loop
    ? budgetSpent
      ? i18nT('components.autoNudgePopover.bound_runtime_budget')
      : capSpent
        ? i18nT('components.autoNudgePopover.bound_cycle_cap')
        : null
    : null

  /** The three fields as the form holds them right now. Parsed from the raw
   *  strings (not a committed number state) so a value typed and then pressed
   *  without an intervening blur is still captured. */
  function formFields(): LoopFields {
    return { message, idle_secs: parseIdle(idleInput), max_cycles: parseCycles(maxCyclesInput) }
  }

  /** The fields the user changed since the popover last showed them (see
   *  `seeded`), and ONLY those -- the body a write of the form carries. Null
   *  when nothing changed. A field the user did not touch is never sent: the
   *  fields seed on the open edge and never re-sync, so an untouched field
   *  holds what the record held THEN, and writing it back would overwrite a
   *  revision another writer landed on it since (a `monitor_update`, another
   *  tab) -- and even an unchanged `message` is a write server-side (it mints
   *  a new goal token). Compared on the PARSED values, so a blur that
   *  normalised "090" to "90" is not an edit. Never seeded reads as all
   *  edited: with no baseline to prove the form untouched, sending it is the
   *  safe default. */
  function editedFields(): Partial<LoopFields> | null {
    const base = seeded.current
    const now = formFields()
    if (!base) return now
    const edited: Partial<LoopFields> = {}
    if (now.message !== base.message) edited.message = now.message
    if (now.idle_secs !== base.idle_secs) edited.idle_secs = now.idle_secs
    if (now.max_cycles !== base.max_cycles) edited.max_cycles = now.max_cycles
    return Object.keys(edited).length ? edited : null
  }
  /** Whether the user has edited anything since the form last showed it --
   *  what the Nudge-now and Save names promise (a save happens only when
   *  true). */
  const formDirty = editedFields() !== null

  /** THE CONTROLS' NAMES. Every control on this surface is ICON-ONLY (product
   *  owner, 2026-09-30 23:22Z): a glyph, and its name sent out twice -- as the
   *  `aria-label` a screen reader announces (`icon-buttons-need-labels`,
   *  website/AUTOSDE.yaml) and as the `title` a hover shows -- with no visible
   *  label text. That is the dashboard's own convention: the per-message
   *  toolbar (copy, link, pin, code, refresh, more) and the composer (mic,
   *  enhance, send) are icon buttons with hover text, a first-time user learns
   *  those the same way, and this popover is not to be the one surface with
   *  text labels. The wording is state-aware where the press is, exactly as
   *  the visible labels were: a control names what THIS press does.
   *  - Nudge now (Zap, schedule line): "Nudge now" on a pristine form, "Save
   *    edits and nudge now" once a field differs -- a static "save and nudge"
   *    promised a save that a pristine press never makes (`triggerNow`).
   *  - Save (running row): "Save" pristine, "Save without nudging" dirty --
   *    beside a Nudge now reading "Save edits and nudge now", a bare "Save" left
   *    a reader unable to tell the two writes apart. Both flip on `formDirty`,
   *    so the pair can never disagree.
   *  - Play: "Resume loop and nudge now" on the paused record, "Start loop and
   *    nudge now" on a stopped one -- the one difference between Paused and
   *    Stopped a reader asked for, beside the status word -- and main's own
   *    "Start loop" with no loop, where the press creates and starts the loop
   *    and does not nudge (`startNow`). On an EDITED paused or stopped form the
   *    two read "Save edits, resume loop and nudge now" / "Save edits, start
   *    loop and nudge now": the press saves the edits first (`resumeNow`), and
   *    a reader of the pristine name on an edited form could not tell how the
   *    edit got kept. Same `formDirty` reading as Zap and Save.
   *  - Stop: "Stop loop" on a live goal (paused, or running with writes
   *    disabled), "Clear stopped goal" on a stopped record, where "Stop loop"
   *    read as a no-op on a loop that is not running.
   *  Text stays only on the erase confirm's two buttons (Cancel / Clear): that
   *  is a confirm dialog, not the icon lane. */
  const nudgeNowName = formDirty
    ? i18nT('components.autoNudgePopover.trigger_nudge')
    : i18nT('components.autoNudgePopover.nudge_now')
  const saveName = formDirty
    ? i18nT('components.autoNudgePopover.save_without_nudging')
    : i18nT('components.autoNudgePopover.save')
  const pauseName = i18nT('components.autoNudgePopover.pause_loop')
  const playName = !loop
    ? i18nT('components.autoNudgePopover.start_loop')
    : pausedManually
      ? formDirty
        ? i18nT('components.autoNudgePopover.save_edits_and_resume')
        : i18nT('components.autoNudgePopover.resume_loop')
      : formDirty
        ? i18nT('components.autoNudgePopover.save_edits_and_start')
        : i18nT('components.autoNudgePopover.start_loop_and_nudge')
  const stopName = loop?.active || pausedManually
    ? i18nT('components.autoNudgePopover.stop_loop')
    : i18nT('components.autoNudgePopover.clear_stopped_goal')
  /** An icon-only `Btn` is square: equal padding around the 14px glyph in
   *  place of the text button's wider sides (`twMerge` lets `p-1.5` replace
   *  the primitive's `px-2.5 py-1`). */
  const ICON_BTN = 'p-1.5'

  const JSON_HEADERS = { 'Content-Type': 'application/json' }

  /** Every write this popover makes to a loop -- the PATCH of the fields or of
   *  `active`, the POST create, the POST fire -- goes through this one
   *  mutation, so each has the same lifecycle: the refusal surfaces as the
   *  thrown error the pressing handler renders inline, and a success
   *  invalidates the shared loops query so the full-registry readers (the Crew
   *  Members patrol block) never keep a stale copy of a record a write just
   *  changed. Resolves to the record the server returned (the fire route
   *  returns the loop unchanged; a DELETE has none, and stays its own call). */
  const loopWrite = useMutation({
    mutationFn: async ({ url, method, body }: { url: string, method: 'PATCH' | 'POST', body?: unknown }): Promise<AutoNudgeLoop> => {
      const resp = await fetch(url, body === undefined
        ? { method }
        : { method, headers: JSON_HEADERS, body: JSON.stringify(body) })
      const data = await resp.json().catch(() => ({}))
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`)
      return data.loop
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: AUTONUDGE_LOOPS_QUERY_KEY })
    },
  })

  /** Save: persist the fields the user edited, nothing else (`editedFields`;
   *  a pristine form sends an empty PATCH, which writes nothing and returns
   *  the record as it stands). In the row of a RUNNING loop only: on a paused
   *  or stopped loop there is no Save -- the one accented Play saves the
   *  edited fields, resumes and fires (product owner, 2026-09-30 23:22Z, see
   *  the action rows).
   *
   *  Never carries `active`. Starting, resuming and reviving belong to Play,
   *  so a save of edited fields leaves the loop exactly as it was -- running,
   *  or paused (a field-only update keeps an inactive loop inactive and its
   *  deadline cleared); the field would be a no-op while the loop is still
   *  running and exactly wrong when it is not -- another tab's Pause, or a
   *  spent bound, can land between this render and the press, and a save
   *  carrying `active: true` would then revive the loop (`update` clears the
   *  stop reason and re-arms the timer) as a side effect of editing text. The
   *  one control on this surface that CLOSES the popover on success, as it
   *  always did: it changes nothing the popover could show, so closing is its
   *  confirmation. Every control that fires or changes the run state stays
   *  open instead (see `runControl`). */
  async function save() {
    if (!loop || writeDisabled) return
    setSaving(true)
    setError('')
    try {
      const saved = await loopWrite.mutateAsync({ url: `/api/autonudge/${loop.id}`, method: 'PATCH', body: editedFields() ?? {} })
      onChange(saved)
      onOpenChange(false)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  /** Stop a PAUSED loop, or clear an already-stopped one -- both behind the
   *  erase confirm, because both remove the record for good. Not reachable
   *  from a running loop: that row offers Pause, and Stop appears once the
   *  loop is paused (product owner, 2026-09-30), so nothing on this surface
   *  erases a running goal in one press. The one exception is a running loop
   *  while writes are disabled, where Pause cannot be pressed and the record
   *  could otherwise never be cleared: Stop is drawn there, behind the same
   *  confirm. */
  async function stop(intent: 'stop' | 'clear') {
    if (!loop) return
    setSaving(true)
    try {
      // The INTENT travels with the request, because the server otherwise
      // decides what this verb means from the record's state at arrival time:
      // a press meant as "Stop loop" on a popover rendered moments earlier
      // would silently ERASE a record that went terminal in between. The server
      // 409s on a mismatch instead, and the popover surfaces that. It is the
      // LABEL the user pressed, supplied by the button, never re-derived from
      // `loop.active` here: a paused loop is inactive yet its control is Stop.
      const resp = await fetch(`/api/autonudge/${loop.id}?intent=${intent}`, { method: 'DELETE' })
      if (!resp.ok) {
        // Parse JSON body for server-supplied error (e.g. 503 when feature disabled).
        // Only on error path: a successful DELETE may return 204 No Content.
        const data = await resp.json().catch(() => ({}))
        throw new Error(data.error || `HTTP ${resp.status}`)
      }
      onChange(null)
      onOpenChange(false)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  /** Pause the loop IN PLACE (`active: false`).
   *
   *  No new backend: `PATCH /api/autonudge/{id}` already accepts `active`, and
   *  the service records `stopped_reason: "manual"` on a pause of a RUNNING
   *  loop (`_update_unserialized` in `src/kiro_crew/autonudge.py`) -- the
   *  reason that tells the paused state from a stopped one when the record
   *  comes back. A pause that reaches a loop a bound already stopped is not a
   *  new stop there: the service keeps the bound and answers with the record as
   *  it stands, which is what goes up to the parent, so a press made off a
   *  stale running reading ends in Stopped, never in Paused. A pause on a
   *  running loop that sits at its cap IS sent: it is the route to Stop, and
   *  the record it produces still names the cap off its numbers. Only a
   *  record carrying the budget reason (`pauseBlocked`) is not sent at all --
   *  the control is disabled, and this refuses too. The body carries
   *  ONLY `active`: a pause is not a save, so whatever sits in the fields
   *  stays unsaved and un-sent.
   *
   *  Does NOT close the popover, for the same reason `triggerNow` does not: the
   *  textarea may hold an unsaved edit with no dirty guard, and the outcome is
   *  visible in place -- the countdown gives way to "Paused", this control's
   *  slot flips to Play and Stop appears beside it. */
  async function pause() {
    if (!loop || writeDisabled || pauseBlocked) return
    setSaving(true)
    setError('')
    try {
      // The write's success also invalidates the shared loops query, so the
      // full-registry readers (the Crew Members patrol block) do not keep
      // showing a countdown for a loop that just paused.
      const pausedRecord = await loopWrite.mutateAsync({ url: `/api/autonudge/${loop.id}`, method: 'PATCH', body: { active: false } })
      onChange(pausedRecord)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  /** The fire controls' shared shape: an optional WRITE of the record, then
   *  the FIRE, then ONE hand-off of the settled record to the parent
   *  (`handUpAfterFire`).
   *
   *  Whether the write carries the form is decided by ONE rule, `editedFields`:
   *  a control that fires saves the form first ONLY when the user edited it,
   *  and sends only the fields edited. Play on a paused or stopped loop with
   *  an edit writes those fields with `active: true` and fires; with a
   *  pristine form it sends `active: true` alone (`resumeNow`). Trigger on a
   *  running loop with an edit writes those fields and fires; with a pristine
   *  form it fires and writes nothing (`triggerNow`). Play with no loop is
   *  the one press here that does NOT fire: it creates and starts the loop
   *  from the form (`startNow`), and the first nudge goes out at the interval
   *  or when the user presses Nudge now on the running loop -- main's own
   *  Start loop -> Trigger nudge flow (product owner, 2026-10-01 00:35Z).
   *  The flow this buys is pause -> edit the goal, interval or cap -> press
   *  Play, with a cap raised in the form travelling with the revive instead of
   *  the loop re-stopping a tick later on the spent cap. There is no separate
   *  Save on an inactive loop: Play is the one control, and it carries the
   *  edit (product owner, 2026-09-30 23:22Z).
   *  The pristine half is what keeps the fields from being a hazard: they seed
   *  on the open edge and never re-sync, so a revision that landed
   *  out-of-band while the popover sat open -- a `monitor_update` from the
   *  nudged agent, another tab's save -- is NOT in the form, and an untouched
   *  form is not written back over it. What fires then is what the loop holds,
   *  read server-side.
   *
   *  The write comes FIRST because `fire_now` fires whatever the loop holds and
   *  refuses an inactive loop with 409: firing before the write would fire the
   *  old goal, or nothing. The two legs are NOT a transaction, on purpose. A
   *  refused write fires nothing -- there is nothing to fire. A write that
   *  lands followed by a refused fire (409 while a turn is in flight, or
   *  mid-fire) leaves the loop written -- saved or resumed -- with the
   *  refusal in the inline notice: the user asked for two things and got one,
   *  and rolling the write back would turn a refused shortcut into an undone
   *  edit or an undone pause.
   *
   *  STAYS OPEN, in every case, and so do Pause and Play. The outcome is
   *  visible in place -- the row flips (a created or resumed loop shows Pause
   *  and Save, the schedule line reads due and carries Nudge now), and a
   *  refusal needs somewhere to land. Only Save closes the popover (see
   *  `save`): it is the one control whose result the popover cannot show. */
  async function runControl(sequence: () => Promise<void>) {
    if (writeDisabled) return
    setSaving(true)
    setError('')
    try {
      await sequence()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  /** The write leg. Returns the record the server wrote (the create's id is
   *  minted server-side, so it is read off the response rather than the
   *  closure). `fieldsSent` is the form as it went out, or null for a write
   *  that carried no fields: the fields that went out are now what the record
   *  holds AND what the user last saw, so they rejoin the pristine baseline --
   *  a second press with no further edit sends nothing again. They rejoin it
   *  as the server STORED them, read off the returned record, not as they were
   *  sent (`adoptStored`). The fields NOT sent keep their baseline: they were
   *  not shown anew, and the record may hold another writer's value for them.
   *  Hands NOTHING up itself -- see `handUpAfterFire`. */
  async function writeLoop(write: { url: string, method: 'PATCH' | 'POST', body: unknown }, fieldsSent: Partial<LoopFields> | null): Promise<AutoNudgeLoop> {
    const written = await loopWrite.mutateAsync(write)
    if (fieldsSent) adoptStored(written, fieldsSent)
    return written
  }

  /** The form and its pristine baseline take what the server STORED for the
   *  fields a write carried. The service does not store a write verbatim: it
   *  clamps the interval into its floor and ceiling and the cap to zero or
   *  more (`autonudge_service/mutations.py`), and the write route returns the
   *  record as stored. Seeding the baseline from the SENT values would leave
   *  an interval typed as 1 showing "1" over a record running at 15 while the
   *  form reads pristine -- a value the loop does not run at, with no edit
   *  left to make the gap visible, and the next press writing the 1 back
   *  again. So each field that went out re-syncs to the returned value, and
   *  the baseline moves with it, under the same `||` fallbacks as the
   *  open-edge seed so a pristine form compares equal to what it shows. A
   *  response without the record (a legacy stub) falls back to the sent
   *  values: nothing better is known. */
  function adoptStored(written: AutoNudgeLoop | null | undefined, fieldsSent: Partial<LoopFields>) {
    const next = { ...(seeded.current ?? formFields()) }
    if ('message' in fieldsSent) {
      next.message = written ? written.message || DEFAULT_MSG : fieldsSent.message ?? next.message
      setMessage(next.message)
    }
    if ('idle_secs' in fieldsSent) {
      next.idle_secs = written ? written.idle_secs || 60 : fieldsSent.idle_secs ?? next.idle_secs
      setIdleInput(String(next.idle_secs))
    }
    if ('max_cycles' in fieldsSent) {
      next.max_cycles = written ? written.max_cycles || 0 : fieldsSent.max_cycles ?? next.max_cycles
      setMaxCyclesInput(String(next.max_cycles))
    }
    seeded.current = next
  }

  /** The fire leg: bring the loop's next cycle forward to now. Returns the
   *  record with the armed deadline on it.
   *
   *  Sends NO body -- the nudge fired is whatever the loop holds, read
   *  server-side: the form's text when a write a moment earlier carried it,
   *  otherwise the record as it stands, out-of-band revisions included.
   *  The route returns the loop UNCHANGED: the server-side deadline write was
   *  removed because it could not be made durable without a suspension point
   *  that raced several lock-free writers. Rendering the response verbatim
   *  would therefore leave the countdown showing the very cycle this press
   *  superseded -- the one visible confirmation a press has. So the armed
   *  deadline is set here instead. Not a fiction: the cycle IS armed to run
   *  now, and the delivery's `autonudge_state` frame reconciles the shared
   *  cache moments later. Throws on refusal so `runControl` lands it in
   *  the inline notice. */
  async function fireNow(loopId: string): Promise<AutoNudgeLoop> {
    const fired = await loopWrite.mutateAsync({ url: `/api/autonudge/${loopId}/fire`, method: 'POST' })
    return { ...fired, next_due_ts: Date.now() / 1000 }
  }

  /** The fire leg after a write, with the press's ONE hand-off to the parent.
   *
   *  One `onChange` per press, after the fire settles, because the parent
   *  re-identifies the record on every hand-off (ChatPage dispatches it into
   *  the store) and the bridge's `onChange` guard drops a hand-off whose
   *  closure no longer addresses the record the parent holds -- another loop,
   *  or none -- and one the loop has fired past since the press. Two hand-offs
   *  -- the written record, then the fired one -- lost the second: the
   *  schedule kept reading a full countdown and Trigger never disabled on the
   *  due cycle. The guard keys on the record, not the object: the write leg's
   *  PATCH publishes an `autonudge_state` frame that re-identifies the SAME
   *  loop before the fire leg is back, and that frame costs the press nothing.
   *  So: the fired record (armed deadline on it) when the fire lands; the
   *  WRITTEN record when the fire is refused -- the loop is saved or resumed
   *  either way, and the parent must learn that -- with the refusal rethrown
   *  into the inline notice. `written` is null for a press that wrote nothing
   *  (a pristine Trigger): a refused fire then hands up nothing, since nothing
   *  changed. Every press that reaches this fires on the id it was pressed
   *  on, so the hand-off re-renders THIS instance (the bridge keys the popover
   *  on the record's id) and the refusal lands where it was set; a create
   *  never comes here (`startNow`). */
  async function handUpAfterFire(loopId: string, written: AutoNudgeLoop | null) {
    let fired: AutoNudgeLoop
    try {
      fired = await fireNow(loopId)
    } catch (e: unknown) {
      if (written) onChange(written)
      throw e
    }
    onChange(fired)
  }

  /** Play on a paused or stopped loop: resume (or revive), fire -- and save
   *  the form on the way, when the user edited it. `active: true` clears the
   *  stop reason and re-arms the timer on a fresh full countdown
   *  (`_update_unserialized`), one interval too late for a user who just
   *  pressed Play -- hence the fire leg. A pristine form sends `active` alone,
   *  so a revision that landed while the loop sat paused is what resumes. */
  function resumeNow() {
    if (!loop) return
    const fields = editedFields()
    return runControl(async () => {
      const written = await writeLoop(
        { url: `/api/autonudge/${loop.id}`, method: 'PATCH', body: { ...fields, active: true } },
        fields,
      )
      if (written?.id) await handUpAfterFire(String(written.id), written)
      else onChange(written)
    })
  }

  /** Play with no loop: create and start it from the form (today's POST) and
   *  hand the created record up -- NO fire (product owner, 2026-10-01 00:35Z).
   *  The first nudge goes out after `idle_secs`, or when the user presses
   *  Nudge now on the running loop, exactly as main's Start loop -> Trigger
   *  nudge flow did. The hand-off re-keys the popover onto the created id (the
   *  bridge keys it on the record), and with no leg behind it there is nothing
   *  a remount could lose: a refused create throws before any hand-off and
   *  lands in this instance's notice. */
  function startNow() {
    const fields = formFields()
    return runControl(async () => {
      const written = await writeLoop(
        { url: '/api/autonudge', method: 'POST', body: { slot_key: slotKey, ...fields } },
        fields,
      )
      onChange(written)
    })
  }

  /** Trigger on a running loop: fire -- saving the form first when the user
   *  edited it (never `active`: a running loop's write must not be able to
   *  revive one another tab paused between render and press). A pristine form
   *  writes nothing, so the armed goal fires as the loop holds it. */
  function triggerNow() {
    if (!loop) return
    const fields = editedFields()
    return runControl(async () => {
      const written = fields
        ? await writeLoop({ url: `/api/autonudge/${loop.id}`, method: 'PATCH', body: fields }, fields)
        : null
      await handUpAfterFire(String(loop.id), written)
    })
  }

  // ── Countdown to the next trigger (#6482) ──
  // The 1s ticker runs only while the popover is OPEN (review finding: a
  // closed-but-armed loop must not re-render the toolbar button every second
  // all day). The hover affordance needs no ticker: a native title tooltip
  // snapshots at hover-start, so the trigger's onMouseEnter/onFocus refresh
  // nowTs once, which is exactly the freshness a tooltip glance can show.
  const ticking = open && !!loop?.active && (loop.next_due_ts || 0) > 0
  const [nowTs, setNowTs] = useState(() => Date.now() / 1000)
  useEffect(() => {
    if (!ticking) return
    setNowTs(Date.now() / 1000)
    const timer = setInterval(() => setNowTs(Date.now() / 1000), 1000)
    return () => clearInterval(timer)
  }, [ticking])
  const refreshNow = () => setNowTs(Date.now() / 1000)
  /** Hover/popover line for the next trigger, or '' when no active loop — the
   *  shared deadline-preserving reading (see `nextCycleText`). */
  const countdownText = nextCycleText(loop, nowTs)
  /** The schedule reading of a RUNNING loop whose count sits at its cap. The
   *  tick the countdown counts to does not nudge: the timer's cap check runs
   *  before any fire and deactivates the loop (`cycle_cap`, see the service's
   *  tick), so "Next cycle in 24s" beside "Cycle cap reached" read as a
   *  contradiction -- a countdown to a nudge that will not happen. One line,
   *  two sentences: what the tick DOES, then the bound and what lifts it,
   *  with the time while one is counting and without once the tick is due
   *  (or, before the timer arms it, unscheduled). Empty for every other loop,
   *  so the plain countdown renders. */
  const cappedTickText = (() => {
    if (!loop?.active || !capSpent) return ''
    const tick = nextCycle(loop, nowTs)
    return tick.kind === 'in'
      ? i18nT('components.autoNudgePopover.capped_tick_in', { time: tick.time })
      : i18nT('components.autoNudgePopover.capped_tick')
  })()
  /** The tooltip only carries a REAL deadline signal (counting or due) — the
   *  "not yet scheduled" placeholder is popover-only, so an armed-but-unscheduled
   *  loop keeps the plain "Goal active (cycle N)" title. */
  const titleCountdown = loop?.active && (loop.next_due_ts || 0) > 0 ? countdownText : ''
  /** Cycle readout for the chip, tooltip and popover header ("3/24", or a
   *  bare "3" under an infinite cap). Interpolated as the {{cycle}} VALUE of
   *  the existing strings, so no catalogue text changes. Unlike the countdown
   *  this is safe in aria-label: it changes once per cycle, not once per
   *  second. */
  /** Whether a cycle is ALREADY armed to run. Derived from the same countdown
   *  the schedule line renders, so the button and the text can never disagree. */
  const cycleAlreadyDue =
    countdownText === i18nT('components.autoNudgePopover.next_cycle_due')
  /** Help line under the goal textarea while it carries the raw kill-switch
   *  token; '' otherwise. See the JSX comment at the render site (#10458). */
  const stopFileHelp = message.includes(STOP_FILE_TOKEN)
    ? loop && loop.stop_sentinel_path === ''
      ? i18nT('components.autoNudgePopover.stop_file_help_none', { token: STOP_FILE_TOKEN })
      : i18nT('components.autoNudgePopover.stop_file_help', { token: STOP_FILE_TOKEN })
    : ''
  const stopFileHelpId = useId()

  const cycleText = loopCycleText(loop)
  const judge = judgeReading(loop)
  // A localized word per verdict outcome. The backend's token is a stable
  // identifier in a line every armed-loop owner reads, and an owner reading a
  // localized sentence should not meet an English identifier inside it. Keyed by
  // the kernel's four-value outcome set, with a word for the record's own
  // "unknown" so an unmapped token still reads as a word.
  const JUDGE_OUTCOME_WORD: Record<string, string> = {
    quiet: i18nT('components.autoNudgePopover.judge_outcome_quiet'),
    wake: i18nT('components.autoNudgePopover.judge_outcome_wake'),
    terminal: i18nT('components.autoNudgePopover.judge_outcome_terminal'),
    fallback: i18nT('components.autoNudgePopover.judge_outcome_fallback'),
  }
  const judgeOutcomeWord = (outcome: string) =>
    JUDGE_OUTCOME_WORD[outcome] ?? i18nT('components.autoNudgePopover.judge_outcome_unknown')

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      {trigger ? <PopoverTrigger asChild>{trigger}</PopoverTrigger> : (
      <PopoverTrigger asChild>
        <button
          className={`h-8 px-2 rounded-lg text-[12px] font-mono flex items-center gap-1 cursor-pointer transition-all bg-transparent border-none shrink-0 whitespace-nowrap ${
            loop?.active
              ? interrupted
                ? 'text-warn hover:text-warn hover:bg-warn/10'
                : 'text-accent hover:text-accent hover:bg-accent/10 animate-pulse'
              : 'text-muted hover:text-text hover:bg-bg-hover'
          }`}
          title={loop?.active ? `${interrupted ? i18nT('components.autoNudgePopover.goal_interrupted_cycle', { cycle: cycleText }) : i18nT('components.autoNudgePopover.goal_active_cycle', { cycle: cycleText })}${titleCountdown ? ` · ${titleCountdown}` : ''}` : i18nT('components.autoNudgePopover.set_a_goal')}
          // The countdown stays OUT of aria-label (review finding): a
          // per-second label change re-announces the button to screen readers.
          aria-label={loop?.active ? (interrupted ? i18nT('components.autoNudgePopover.goal_interrupted_cycle', { cycle: cycleText }) : i18nT('components.autoNudgePopover.goal_active_cycle', { cycle: cycleText })) : i18nT('components.autoNudgePopover.set_a_goal')}
          onMouseEnter={refreshNow}
          onFocus={refreshNow}
        >
          <Goal size={16} className="shrink-0" />
          {loop?.active && loop.cycle_count > 0 ? cycleText : null}
        </button>
      </PopoverTrigger>
      )}
      {content ?? <PopoverContent
        side="top"
        align="start"
        /* Viewport-capped rather than a pinned 420px: at the 320px floor a fixed
           width pushes this panel -- and the right-aligned action below -- past the
           usable viewport. Written as a max so there is no `md:` counterpart to keep
           in sync: 420px is simply the ceiling, and a phone gets the width it has. */
        className="w-[min(calc(100vw-1rem),26.25rem)] max-h-[min(80vh,42rem)] overflow-y-auto p-4 text-[12px]"
      >
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2 font-medium text-text">
            <Goal size={14} className={loop?.active ? 'text-accent' : 'text-muted'} />
            {i18nT('components.autoNudgePopover.set_a_goal')}
            {loop?.active && <span className="text-muted text-[11px]">{i18nT('components.autoNudgePopover.cycle')} {cycleText}</span>}
          </div>
          <button aria-label={i18nT('components.autoNudgePopover.close')} title={i18nT('components.autoNudgePopover.close')} onClick={() => onOpenChange(false)} className="text-muted hover:text-text bg-transparent border-none cursor-pointer">
            <X size={14} />
          </button>
        </div>
        {onSetUpBoundedMonitor ? (
          <>
            {/* An OFFER, not a way back: this editor is the view the popover
                opens on, so a reader arriving here has no bounded monitor
                behind them to return to. Hence a Radar glyph rather than a left
                arrow, and a label naming the SUBJECT that surface takes -- it
                accepts a pull request URL and nothing else, so a label reading
                only "bounded monitor" walks a reader with any other goal into
                a form whose one field they cannot fill.
                Underlined without hovering, because this is now the ONLY route
                to the monitor: a usability reader could not tell 11px muted
                text was clickable at all, and a hover-only affordance is
                invisible on a touch viewport. */}
            <button
              type="button"
              onClick={onSetUpBoundedMonitor}
              className="mb-2 inline-flex items-center gap-1 border-none bg-transparent p-0 text-[11px] text-muted underline cursor-pointer hover:text-text"
            >
              <Radar size={13} className="lucide-inline" aria-hidden />
              {i18nT('components.sessionAutomationPopover.set_up_bounded_monitor')}
            </button>
            {/* Warn-coloured, unchanged from when this form was opt-in. Muting
                it read better to the author and worse to review: on the view
                every reader now lands on, this sentence is the only cost cue
                the surface carries, and dropping its colour weakened that cue
                in the same change that made the surface the default. */}
            <p role="note" className="mb-2 rounded-md border border-warn/30 bg-warn-subtle px-2 py-1.5 text-[11px] text-warn-fg">
              {i18nT('components.sessionAutomationPopover.legacy_notice')}
            </p>
          </>
        ) : null}
        <p className="text-muted text-[11px] mb-3 leading-relaxed">{i18nT('components.autoNudgePopover.give_the_agent_a_goal_and_it_will_keep_working_t')}</p>

        {watchesFailed && (
          <div className="flex items-center justify-between gap-2 mb-3">
            {/* No hand-off: the popover holds the unsaved goal message, idle and max-cycle inputs.
                Retry is the recovery path, as on every sibling load-failure notice. */}
            <ErrorNotice
              variant="inline"
              testId="auto-nudge-watches-error"
              message={i18nT('components.autoNudgePopover.watches_load_failed')}
            />
            <button
              type="button"
              onClick={() => { void refetchWatches() }}
              className="px-2 py-0.5 rounded border border-border text-[11px] text-muted hover:text-text bg-transparent cursor-pointer shrink-0"
            >
              {i18nT('components.autoNudgePopover.retry')}
            </button>
          </div>
        )}

        {watches.length > 0 && (
          <div className="border border-border rounded p-2 mb-3">
            <div className="text-text text-[11px] font-medium mb-1">
              {i18nT('components.autoNudgePopover.watches_title')}
            </div>
            <ul className="list-none p-0 m-0 mb-1">
              {watches.map(w => (
                <li key={w.id} className="text-muted text-[11px] leading-relaxed">
                  <span className="text-text">{w.name}</span>
                  {w.schedule && <span> · {w.schedule}</span>}
                  {w.next_run_ts && (
                    <span> · {i18nT('components.autoNudgePopover.watches_next')} {fmtTimeNumeric(w.next_run_ts)}</span>
                  )}
                </li>
              ))}
            </ul>
            <div className="text-muted text-[11px] leading-relaxed">
              {i18nT('components.autoNudgePopover.watches_note')}
            </div>
          </div>
        )}

        {/* The reason the fields below are dead. `writeDisabled` alone renders a
            form a crew/member reader cannot use and does not say why: the
            explanation used to live on the bounded view, which was the default,
            and making the goal loop the default left the disabled form with no
            reason attached.
            Rendered from the boolean rather than through a `reason` prop. The
            prop was a one-consumer generalization -- its single caller passed
            one constant gated on this same condition -- and the rationale for
            it ("the editor knows nothing about session modes") was already
            false, since this component reads `sessionAutomationPopover` strings
            two lines up. A second reason for disabling writes would need the
            reason back as a parameter; there is exactly one today. */}
        {writeDisabled ? (
          <p
            role="status"
            data-testid="auto-nudge-write-disabled-reason"
            className="mb-3 rounded-md border border-border bg-bg px-2 py-1.5 text-[11px] leading-relaxed text-muted"
          >
            {i18nT('components.sessionAutomationPopover.session_mode_unavailable')}
          </p>
        ) : null}

        <div className="text-muted text-[11px] mb-1">{i18nT('components.autoNudgePopover.goal_description')}</div>
        <textarea
          aria-label={i18nT('components.autoNudgePopover.goal_description')}
          value={message}
          disabled={writeDisabled}
          onChange={e => { hasEdited.current = true; setMessage(e.target.value) }}
          rows={6}
          className="w-full bg-bg border border-border rounded p-2 text-[12px] font-mono resize-y mb-3 text-text"
          placeholder={i18nT('components.autoNudgePopover.describe_what_you_want_the_agent_to_accomplish')}
          aria-describedby={stopFileHelp ? stopFileHelpId : undefined}
        />
        {stopFileHelp ? (
          /* Display-only explanation of the raw token above (#10458). The
             textarea keeps `{{STOP_FILE}}` because the server substitutes it
             when each nudge is sent; only the human reading the form needed
             telling what it turns into. Shown while the goal text carries the
             token, so a custom goal without it gets no orphan help line. The
             empty-sentinel arm reads the ARMED loop's record: a loop that
             carries an explicitly empty `stop_sentinel_path` has nothing to
             substitute, so the honest line is that the token goes out blank
             and Stop loop is the way to halt it. The path itself is never
             rendered: the websocket frame withholds it and this surface has no
             owner gate. */
          <p id={stopFileHelpId} className="text-muted text-[11px] leading-relaxed -mt-2 mb-3">
            {stopFileHelp}
          </p>
        ) : null}

        <div className="flex flex-col gap-3 mb-3 sm:flex-row">
          <div className="flex-1">
            <div className="text-muted text-[11px] mb-1">{i18nT('components.autoNudgePopover.seconds_between_nudges')}</div>
            <input
              type="number"
              aria-label={i18nT('components.autoNudgePopover.seconds_between_nudges')}
              min={15}
              max={86400}
              value={idleInput}
              disabled={writeDisabled}
              onChange={e => { hasEdited.current = true; setIdleInput(e.target.value) }}
              onBlur={() => setIdleInput(String(parseIdle(idleInput)))}
              className="w-full bg-bg border border-border rounded px-2 py-1 text-[12px] text-text"
            />
          </div>
          <div className="flex-1">
            <div className="text-muted text-[11px] mb-1">{i18nT('components.autoNudgePopover.max_cycles_0')}</div>
            <input
              type="number"
              aria-label={i18nT('components.autoNudgePopover.max_cycles_0_infinite')}
              min={0}
              value={maxCyclesInput}
              disabled={writeDisabled}
              onChange={e => { hasEdited.current = true; setMaxCyclesInput(e.target.value) }}
              onBlur={() => setMaxCyclesInput(String(parseCycles(maxCyclesInput)))}
              className="w-full bg-bg border border-border rounded px-2 py-1 text-[12px] text-text"
            />
          </div>
        </div>

        {/* The SCHEDULE line: last fire, the countdown (or "Paused" / "Stopped"),
            the NUDGE-NOW button of a running loop under it, and, for a stopped
            loop, the help line naming its two exits (or, while the erase confirm
            is up, its question). Nudge now sits here and not in the action row
            (product owner, 2026-09-30: "Move trigger back to schedule line"):
            it is a shortcut on the schedule the line describes, and the row
            below keeps to the two controls the rule allows. Rendered for every
            loop; with no loop there is no schedule to read. */}
        {loop && (
          <div className="flex flex-col items-start gap-1 mb-3" data-testid="auto-nudge-schedule">
            <div className="text-muted text-[11px]">
              {i18nT('components.autoNudgePopover.last_fire')} {loop.last_fire_ts ? fmtTimeNumeric(loop.last_fire_ts) : i18nT('components.autoNudgePopover.never')}
              {cappedTickText ? (
                /* A RUNNING loop at its cap: the tick the countdown counts to
                   will stop the loop on the cap rather than fire a nudge, so
                   the line says THAT (see `cappedTickText`) instead of a
                   countdown to a "next cycle" beside the bound -- read as a
                   contradiction. The one interval the loop sits at its cap is
                   not silent, and the Pause below (live) has its context. */
                <span> · <span data-testid="auto-nudge-capped-tick">{cappedTickText}</span></span>
              ) : (
                <>
                  {countdownText && <span> · {countdownText}</span>}
                  {/* Any OTHER bound on a running record beside its countdown
                      (`boundReason`; the cap has its own sentence above). */}
                  {loop.active && boundReason && (
                    <span> · <span data-testid="auto-nudge-bound-reason">{boundReason}</span></span>
                  )}
                </>
              )}
              {/* "Paused" takes the countdown's slot: a paused loop holds no
                  schedule (`next_due_ts` is cleared), so the state IS the
                  schedule reading. Says "Paused" -- the word the Stopped branch
                  below deliberately avoids -- because here it is true: the Play
                  in the row resumes this same record where it left off. */}
              {pausedManually && (
                <span> · <span data-testid="auto-nudge-loop-paused-manually">{i18nT('components.autoNudgePopover.loop_paused')}</span></span>
              )}
              {/* The bound holding Play, after the status word it qualifies: a
                  paused loop whose count already sits at its cap has a Resume
                  the timer would turn away, and the line says so and what
                  lifts it (see `boundReason`). The Stopped row below carries
                  the same span for a stopped loop. */}
              {pausedManually && boundReason && (
                <span> · <span data-testid="auto-nudge-bound-reason">{boundReason}</span></span>
              )}
            </div>
            {/* The judge's own line, under the schedule it modifies. Drawn only for a
                loop that carries a brief, so a plain timer gains no row. The verdict
                half is omitted until one exists: "no verdict yet" is a different
                statement from a quiet answer, and reading a fresh judge as quiet
                would say a tick was skipped that never happened. What it shows is
                the outcome, the item COUNT and the time -- never the evidence, and
                never a probability, which lives in the decisions log where the
                thresholds are tuned. */}
            {/* ``break-words`` because the criterion is the owner's own sentence and may hold a
                token with no spaces in it -- a URL, a sha, a pasted blob. Without it such a
                criterion does not wrap, it OVERFLOWS the popover horizontally. Wrapping
                rather than clamping: the row shows the whole criterion on purpose, so the
                owner can confirm what they armed. */}
            {judge.kind === 'armed' && (
              <div className="text-muted text-[11px] break-words" data-testid="judge-line">
                {i18nT(
                  judge.sense === 'wake'
                    ? 'components.autoNudgePopover.judge_wake_when'
                    : 'components.autoNudgePopover.judge_quiet_while',
                  { criterion: judge.criterion },
                )}
                {judge.verdict ? (
                  <span>
                    {' · '}
                    {/* Two spellings because the time is the only segment that can be
                        absent: a record with no timestamp renders no clock reading, and
                        one interpolated string would leave its separator hanging with
                        nothing after it. A conditional inside the string is not
                        available to a translator, so the choice is made here. */}
                    {judgeVerdictTime(judge.verdict.at)
                      ? i18nT('components.autoNudgePopover.judge_verdict', {
                        outcome: judgeOutcomeWord(judge.verdict.outcome),
                        count: judge.verdict.items,
                        time: judgeVerdictTime(judge.verdict.at),
                      })
                      : i18nT('components.autoNudgePopover.judge_verdict_untimed', {
                        outcome: judgeOutcomeWord(judge.verdict.outcome),
                        count: judge.verdict.items,
                      })}
                  </span>
                ) : (
                  <span> · {i18nT('components.autoNudgePopover.judge_no_verdict')}</span>
                )}
              </div>
            )}
            {loop.active ? (
              /* NUDGE NOW, on the schedule line it shortcuts. Fires the armed
                 goal now (`triggerNow`), saving the form first when the user
                 edited it -- and its name says which (`nudgeNowName`: "Nudge
                 now" on a pristine form, "Save edits and nudge now" once a
                 field differs). Icon-only, like every control here: the Zap
                 glyph, the name as aria-label and as the hover title. Disabled
                 once a cycle is already due, which is what a successful press
                 produces: before this the button re-enabled unchanged, so the
                 press acknowledged itself only through the line's wording -- a
                 reader would not press it a second time because they could not
                 tell whether that would double the nudge or do nothing (it
                 does nothing: the cycle is already armed). Also gated like the
                 writes it may make: writes disabled, or an empty goal, which a
                 dirty press would send. While the erase confirm is up (a
                 running loop's Stop exists only with writes disabled, see the
                 action rows) its QUESTION takes this slot, as it does under
                 the paused and stopped states. */
              confirmClear ? (
                <span data-testid="auto-nudge-clear-question" className="text-muted text-[11px]">
                  {i18nT('components.autoNudgePopover.clear_goal_question')}
                </span>
              ) : (
              <button
                type="button"
                onClick={triggerNow}
                data-testid="auto-nudge-trigger"
                disabled={saving || writeDisabled || cycleAlreadyDue || !message.trim()}
                aria-label={nudgeNowName}
                title={nudgeNowName}
                className="inline-flex items-center p-1 rounded border border-border text-muted hover:text-text hover:border-accent bg-transparent cursor-pointer shrink-0 disabled:opacity-50"
              >
                <Zap size={12} aria-hidden />
              </button>
              )
            ) : pausedManually ? (
              /* No helper sentence under a paused loop: the status word above
                 and the labelled controls below say what the state is and what
                 each press does. The one line that renders here is the erase
                 confirm's QUESTION, while the confirm row has replaced the
                 controls: that row renders no question of its own, so this is
                 where it lives. */
              confirmClear ? (
                <span data-testid="auto-nudge-clear-question" className="text-muted text-[11px]">
                  {i18nT('components.autoNudgePopover.clear_goal_question')}
                </span>
              ) : null
            ) : (
              /* Says WHY there is no countdown, rather than leaving a gap. A
                 blind reader of the stopped screenshot could not tell it was the
                 same loop at all, and an inactive loop otherwise looks identical
                 to an active one whose countdown failed to render -- the state is
                 the reason for the absence, so it belongs in the space the
                 absence leaves.
                 Reads "Stopped", not "Paused": the Stop in the row removes this
                 record for good, and a blind reader took "Paused" as "it
                 remembers where it left off" -- a resumable-sounding status next
                 to an erase control is the mixed message a UX review blocked on.
                 That reasoning still holds here, and it is exactly why "Paused"
                 is reserved for the ONE inactive state that IS resumable in
                 place: a loop with the manual-pause reason, handled above. A
                 spent bound, a tool's tombstone and an unknown reason all land
                 here and stay "Stopped". Beside it the BOUND that holds the
                 Play below, when one does: "Stopped" alone next to a disabled
                 Play left a blind reader with a dead control and no reason
                 (`boundReason` names the bound and, for the cap, the field
                 that lifts it). Under it the help line naming both exits (the
                 removal this PR once made is dropped -- product owner,
                 2026-09-30): the erase is irreversible, and a reader who could
                 not predict what the red control does needs the sentence, not
                 only the label. While confirming, that line must not keep
                 naming the two controls that just left the row -- a blind
                 reader looked for the "Start loop" it describes and could not
                 find it -- and the confirmation row itself renders no question.
                 So the help line BECOMES the question for that state. */
              <div className="flex flex-col items-start gap-0.5">
                <div className="text-muted text-[11px]">
                  <span
                    data-testid="auto-nudge-loop-paused"
                    className="shrink-0"
                  >
                    {i18nT('components.autoNudgePopover.loop_stopped')}
                  </span>
                  {boundReason && (
                    <span> · <span data-testid="auto-nudge-bound-reason">{boundReason}</span></span>
                  )}
                </div>
                {confirmClear ? (
                  <span data-testid="auto-nudge-clear-question" className="text-muted text-[11px]">
                    {i18nT('components.autoNudgePopover.clear_goal_question')}
                  </span>
                ) : (
                  /* While a bound holds the Play below (`playBlocked`), "Start
                     loop resumes this goal" above a switched-off Start is a
                     promise the row does not keep -- a reader called the pair
                     confusing. The bound line above already says what holds
                     Play and, for the cap, what lifts it, so the help keeps
                     only its Clear sentence; the resume sentence comes back
                     the moment Play does (a cap typed above the count). */
                  <span data-testid="auto-nudge-stopped-help" className="text-muted text-[11px]">
                    {i18nT(playBlocked ? 'components.autoNudgePopover.stopped_help_bound' : 'components.autoNudgePopover.stopped_help')}
                  </span>
                )}
              </div>
            )}
          </div>
        )}

        {/* No hand-off: the popover holds the unsaved goal message, idle and max-cycle inputs. */}
        <ErrorNotice
          variant="inline"
          className="mb-2"
          testId="auto-nudge-error"
          message={error}
          onDismiss={() => setError('')}
        />

        {/* THE ACTION ROWS. Layout ruled by the product owner on 2026-09-30, on
            this PR's thread: "Move trigger back to schedule line. Keep Pause and
            Save. Stop appears after hitting pause." So Nudge now lives on the
            schedule line above, and no row here holds more than two controls
            (`max-two-buttons-per-row`, website/AUTOSDE.yaml): an overflow menu
            was and stays rejected -- every control stays visible. Three
            further rulings on 2026-09-30 23:22Z shape what follows:
            (1) ICON-ONLY, WITH HOVER TEXT: every control is a glyph with its
                name in `aria-label` and the same name in `title`, no visible
                label text (see the names above the write helpers for the
                convention argument and the state-aware wording).
            (2) NO "SAVE WITHOUT RESUMING": a paused or stopped loop's row is
                Stop (red, left) and ONE accented Play, which saves the edited
                fields if the form is dirty, then resumes (or starts), then
                fires -- the 2026-09-17 intent. The running row keeps Pause and
                Save.
            (3) The erase confirm's button reads "Clear" ("It's just clear");
                its question line still names the object.
            The rows by state (names = aria-label = title):
              RUNNING            .................. [Pause loop] [Save]
              RUNNING, writes    [Stop loop]  (the one control that still works;
                disabled                       asks first -- see `stop`)
              PAUSED (manual)    [Stop loop] ...... [Resume loop and nudge now]
              STOPPED (a bound,  [Clear stopped goal] . [Start loop and nudge now]
                a tombstone)
              NO LOOP            .................. [Start loop]  (create + start, no fire)
            STOP IS TWO STEPS AWAY FROM A RUNNING LOOP: Pause first, then Stop,
            and Stop asks ("Remove this goal for good?") before it erases -- on
            the paused record and on the stopped one alike, since both presses
            remove the record and its goal text for good. Nothing on this
            surface erases a running goal in one press. Stop is `danger`,
            coloured unconditionally rather than on :hover (a touch viewport
            never produces one), pinned left as the destructive control with
            the primary action on the right, the shape the erase confirm also
            takes.
            Play SAVES THE FORM FIRST WHEN THE USER EDITED IT (`editedFields`,
            see `runControl`): on a paused or stopped loop it writes the edited
            fields with `active: true` and fires, or `active: true` alone when
            nothing was edited. With no loop it creates and starts the loop
            from the form and does NOT fire (`startNow`; product owner,
            2026-10-01 00:35Z) -- main's Start loop, under main's name. */}
        {loop && confirmClear ? (
          /* The erase confirm REPLACES the rows, as the monitor surface's
             identical confirm does: the choice should hold the reader's whole
             attention, and the question renders on the schedule line above.
             The one row with VISIBLE text on this surface: a confirm dialog,
             not the icon lane. Cancel, and the bare verb -- the question above
             it names what is being cleared. The intent that travels is the one
             the pressed control meant (see `stop`): a running or paused loop is
             a live goal being stopped, a stopped record is being cleared. */
          <div className="flex gap-2 justify-end" data-testid="auto-nudge-actions">
            <Btn type="button" onClick={() => setConfirmClear(false)} disabled={saving}>
              {i18nT('components.autoNudgePopover.cancel')}
            </Btn>
            <Btn type="button" danger onClick={() => stop(loop.active || pausedManually ? 'stop' : 'clear')} disabled={saving}>
              {i18nT('components.autoNudgePopover.clear_goal_for_good')}
            </Btn>
          </div>
        ) : loop?.active && writeDisabled ? (
          /* Running while writes are disabled (a crew or member session -- the
             reason line above says why the fields are dead): Pause is a write,
             so the two-step Stop cannot be reached that way, and a stale
             running record could otherwise never be cleared from here. So the
             row holds the one control that still works -- Stop, a DELETE --
             behind the same confirm every other Stop on this surface asks
             first: not a one-press erase even here. The dead Pause and Save
             are not drawn beside it; the reason line, not two disabled
             controls, says why writes are unavailable. */
          <div className="flex items-center gap-2" data-testid="auto-nudge-actions">
            <Btn type="button" danger className={ICON_BTN} onClick={() => setConfirmClear(true)} disabled={saving} aria-label={stopName} title={stopName}>
              <Square size={14} fill="currentColor" aria-hidden />
            </Btn>
          </div>
        ) : loop?.active ? (
          /* Running: Pause and Save, nothing destructive. Both follow Save's
             `writeDisabled` gate; Pause skips the empty-goal gate because a
             pause sends no fields. Pause is held only by the budget reason
             (`pauseBlocked`): a loop sitting at its cycle cap keeps a LIVE
             Pause -- it is the route to Stop, and the paused record still
             names the cap off its numbers -- with the cap named beside the
             countdown above (`boundReason`). The field plays no part: a pause
             writes no cap, so nothing typed can spend or lift one. Save's name
             flips with the form (`saveName`), on the same reading as the Nudge
             now above it. */
          <div className="flex items-center justify-end gap-2" data-testid="auto-nudge-actions">
            <Btn type="button" className={ICON_BTN} onClick={pause} disabled={saving || writeDisabled || pauseBlocked} aria-label={pauseName} title={pauseName}>
              <Pause size={14} aria-hidden />
            </Btn>
            <Btn type="button" primary className={ICON_BTN} onClick={save} disabled={saving || writeDisabled || !message.trim()} aria-label={saveName} title={saveName}>
              <SaveIcon size={14} aria-hidden />
            </Btn>
          </div>
        ) : loop ? (
          /* Paused or stopped: Stop left, Play right, nothing else -- an edit
             rides Play (see the block comment above). Stop asks first and
             stays reachable while writes are disabled, so stale state can
             always be cleared. */
          <div className="flex items-center gap-2" data-testid="auto-nudge-actions">
            <Btn type="button" danger className={ICON_BTN} onClick={() => setConfirmClear(true)} disabled={saving} aria-label={stopName} title={stopName}>
              <Square size={14} fill="currentColor" aria-hidden />
            </Btn>
            <Btn
              type="button"
              primary
              className={`ml-auto ${ICON_BTN}`}
              onClick={resumeNow}
              /* `playBlocked`: a revive the timer would turn away before
                 the nudge is not offered; the field that clears it brings
                 the control back, and `boundReason` on the schedule line
                 says which bound holds it meanwhile. */
              disabled={saving || writeDisabled || !message.trim() || playBlocked}
              aria-label={playName}
              title={playName}
            >
              <Play size={14} aria-hidden />
            </Btn>
          </div>
        ) : (
          /* No loop: Play alone, in the accent -- create and start the loop
             from the form (`startNow`), no fire. Where the cluster sits on a
             loop. */
          <div className="flex items-center justify-end gap-2" data-testid="auto-nudge-actions">
            <Btn
              type="button"
              primary
              className={ICON_BTN}
              onClick={startNow}
              disabled={saving || writeDisabled || !message.trim()}
              aria-label={playName}
              title={playName}
            >
              <Play size={14} aria-hidden />
            </Btn>
          </div>
        )}
      </PopoverContent>}
    </Popover>
  )
}
