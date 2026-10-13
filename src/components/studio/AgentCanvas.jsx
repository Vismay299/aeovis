'use client';

/**
 * The agent canvas.
 *
 * A node graph of a content run: which agent does what, in what order, and —
 * the point of the whole thing — where the human gate sits. Five agents, one
 * person, and a dashed path back from the editor to the writer.
 *
 * The dotted field is a deliberate exception to the "no decorative grid
 * backgrounds" rule: this is an actual pannable canvas surface, not a texture.
 *
 * Node height is fixed at 142px, not min-height. Ports sit at 50% height, so
 * a node that grows a line taller drags its port off the edge that connects
 * to it — the edges are drawn at absolute coordinates and cannot follow.
 */

import { useState } from 'react';
import { Zap, Search, LineChart, PenLine, UserCheck, Clock } from 'lucide-react';

/* Stage → how far the run has actually got. Anything the API has not told us
   about stays queued rather than being guessed at. */
const STAGE_ORDER = {
  /* A run only exists because a gap was found, so the trigger is always
     behind us by the time there is anything to draw. */
  pending: 1,
  coordinating: 2,
  researching: 1,
  benchmarking: 2,
  drafting: 3,
  reviewing: 3,
  awaiting_approval: 4,
  changes_requested: 3,
  approved: 5,
  rejected: 4,
  failed: -1,
};

const NODES = [
  {
    key: 'trigger',
    title: 'Gap detected',
    icon: Zap,
    x: 14,
    blurb: (r) => r.query
      ? `A rival took “${r.query}”.`
      : 'A reading found an answer a rival holds.',
    state: 'Trigger',
    detail: 'The run starts from a lost answer, not from a content calendar. Nothing is written that no engine was asked about.',
    rows: (r) => [
      ['Question', r.query || '—'],
      ['Engines lost', r.enginesLost || '—'],
      ['Intent', r.intent || '—'],
    ],
  },
  {
    key: 'researcher',
    title: 'Researcher',
    icon: Search,
    x: 200,
    blurb: () => 'Reads the sources the engines actually cited.',
    state: 'Research',
    detail: 'Reads every source the engines cited for this question, plus the rival page winning it, and extracts what the answer rewards.',
    rows: (r) => [
      ['Sources read', r.sourcesRead ?? '—'],
      ['Rival pages', r.rivalPages ?? '—'],
    ],
  },
  {
    key: 'strategist',
    title: 'Strategist',
    icon: LineChart,
    x: 386,
    blurb: () => 'Picks the angle the answer rewards.',
    state: 'Strategy',
    detail: 'Chooses the angle. Every rival-held answer organises itself around something; the strategist names it and rejects the rest.',
    rows: (r) => [
      ['Angle', r.angle || '—'],
      ['Rejected', r.rejected || '—'],
    ],
  },
  {
    key: 'writer',
    title: 'Writer',
    icon: PenLine,
    x: 572,
    blurb: () => 'Drafts against the chosen angle, with sources in context.',
    state: 'Draft',
    detail: 'Drafts against the chosen angle with the cited sources in context. It never states a claim it cannot attribute to something the researcher read.',
    rows: (r) => [
      ['Words', r.words ?? '—'],
      ['Citations', r.citations ?? '—'],
      ['Revision', r.revision ?? 0],
    ],
  },
  {
    key: 'editor',
    title: 'Editor · you',
    icon: UserCheck,
    x: 758,
    blurb: () => 'Approve, or send back with a note. Nothing ships without it.',
    state: 'Human gate',
    detail: 'The one step no agent can take. Approve the draft, then export and publish it; send it back and the writer picks it up again with your note attached.',
    rows: (r) => [
      ['Status', r.statusLabel || (r.status ? r.status : 'No active run')],
      ['Blocks', 'Export & measure'],
    ],
  },
  {
    key: 'measure',
    title: 'Export & measure',
    icon: Clock,
    x: 944,
    blurb: () => 'Export the approved draft, publish, then rescan.',
    state: 'Measure',
    detail: 'Export the approved draft and publish it to your website. Run another scan against the same buyer questions to compare visibility and citations; a change alone does not prove which edit caused it.',
    rows: () => [
      ['Runs after', 'Your approval'],
      ['Watches', 'The question that triggered it'],
    ],
  },
];

/* Edge geometry, matched to the node coordinates above. */
const EDGES = [
  { from: 0, d: 'M178,127 L200,127' },
  { from: 1, d: 'M364,127 L386,127' },
  { from: 2, d: 'M550,127 L572,127' },
  { from: 3, d: 'M736,127 L758,127' },
  { from: 4, d: 'M922,127 L944,127' },
];

export function AgentCanvas({ run = {}, title = 'Content run' }) {
  const hasRun = Boolean(run.status);
  const reached = STAGE_ORDER[run.status] ?? 0;
  const [selected, setSelected] = useState('editor');

  const stateOf = (i) => {
    if (!hasRun) return 'planned';
    if (i === 4) return reached >= 4 && reached < 5 ? 'human' : reached >= 5 ? 'done' : 'queued';
    if (i < reached) return 'done';
    if (i === reached) return 'live';
    return 'queued';
  };

  const nodeClass = (i) => {
    const s = stateOf(i);
    return `cvn${s === 'done' ? ' is-done' : ''}${s === 'human' ? ' is-human' : ''}${s === 'queued' ? ' is-queued' : ''}${NODES[i].key === selected ? ' is-sel' : ''}`;
  };

  const edgeClass = (i) => {
    if (i < reached - 1) return 'cve cve--done';
    if (i === reached - 1) return 'cve cve--live';
    return 'cve';
  };

  const current = NODES.find((n) => n.key === selected) || NODES[4];
  const Icon = current.icon;

  return (
    <div className="stack stack--tight">
      <div className="panel">
        <div className="cvbar">
          <b style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink-1)' }}>{title}</b>
          {run.query && <span className="chip chip--you">{run.query}</span>}
          {run.statusLabel && (
            <span className={`chip ${reached >= 5 ? 'chip--good' : reached === 4 ? 'chip--warn' : ''}`}>
              <i className="chip__led" /> {run.statusLabel}
            </span>
          )}
        </div>

        {/* the graph pans inside its own scroller; the page never moves sideways */}
        <div className="cv" data-testid="agent-canvas">
          <div className="cv__stage">
            <svg className="cv__edges" viewBox="0 0 1130 280" aria-hidden="true">
              {EDGES.map((e, i) => (
                <path key={i} className={edgeClass(i)} d={e.d} />
              ))}
              {/* the send-back path: the editor can return the draft to the writer */}
              <path
                className="cve cve--back"
                d="M840,198 C840,228 840,250 800,250 L694,250 C656,250 654,228 654,198"
              />
            </svg>

            {NODES.map((n, i) => {
              const NIcon = n.icon;
              const s = stateOf(i);
              return (
                <button
                  key={n.key}
                  type="button"
                  className={nodeClass(i)}
                  style={{ '--x': `${n.x}px`, '--y': '56px' }}
                  onClick={() => setSelected(n.key)}
                  aria-pressed={n.key === selected}
                  data-testid={`agent-node-${n.key}`}
                >
                  <span className="cvn__h">
                    <span className="cvn__ico">
                      <NIcon size={14} strokeWidth={2} aria-hidden="true" />
                    </span>
                    <b>{n.title}</b>
                  </span>
                  <p>{n.blurb(run)}</p>
                  <span className="cvn__st">
                    {s === 'human' ? 'Waiting on you' : s === 'done' ? 'Done' : s === 'live' ? 'Running' : s === 'planned' ? 'Workflow step' : 'Queued'}
                  </span>
                  {i > 0 && <span className="cvn__p cvn__p--in" />}
                  {i < NODES.length - 1 && <span className="cvn__p cvn__p--out" />}
                  {(i === 3 || i === 4) && <span className="cvn__p cvn__p--down" />}
                </button>
              );
            })}
          </div>
        </div>

        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
            padding: '12px 16px', borderTop: '1px solid var(--line-soft)',
          }}
        >
          <span className="tag">Five agents · one human gate</span>
          <span className="tag" style={{ marginLeft: 'auto' }}>Scroll the canvas to pan</span>
        </div>
      </div>

      {/* ── inspector ────────────────────────────────────────────── */}
      <div className="panel" data-testid="agent-inspector">
        <div className="panel__h">
          <span className="cvn__ico"><Icon size={14} strokeWidth={2} aria-hidden="true" /></span>
          <b>{current.title}</b>
          <span className="chip" style={{ marginLeft: 'auto' }}>{current.state}</span>
        </div>
        <div className="panel__b">
          <p style={{ fontSize: 14.5, color: 'var(--ink-2)', lineHeight: 1.6, marginBottom: 14 }}>
            {current.detail}
          </p>
          <div className="rows">
            {current.rows(run).map(([k, v]) => (
              <div className="row" key={k}>
                <span className="row__n">{k}</span>
                <span className="row__v">{String(v)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default AgentCanvas;
