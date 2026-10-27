import type { Finding, EntityRef } from '@shared/drc'

interface DrcPanelProps {
  findings: Finding[]
  /** Called when the user clicks a selectable finding. Receives the first ref. */
  onSelect: (ref: EntityRef) => void
  /** Resolves the first ref to a Flow id (or null if not selectable in current view). */
  resolve: (ref: EntityRef) => string | null
  /** Hide a finding the user has handled/acknowledged. */
  onDismiss: (f: Finding) => void
  /** How many currently-present findings are hidden by dismissal. */
  dismissedCount: number
  /** Un-hide all dismissed findings. */
  onReset: () => void
  /**
   * How many load-time repairs + migrations this file arrived with. The notice
   * for them used to sit in the docked header; its button already pointed here,
   * so with the header gone it lives in this panel's own header. 0 hides it.
   *
   * Optional (with its handler) because this component is also part of the
   * exported design-system surface (`ds/index.ts`), whose previews render it
   * with no shell around it.
   */
  repairCount?: number
  /** Dismiss the load-repairs notice (the findings themselves stay listed). */
  onDismissRepairs?: () => void
}

/** Read out as a dot's tooltip now rather than printed in a badge. */
const SEVERITY_LABEL: Record<Finding['severity'], string> = {
  error: 'Error',
  warning: 'Warning',
  info: 'Info'
}

export function DrcPanel({
  findings,
  onSelect,
  resolve,
  onDismiss,
  dismissedCount,
  onReset,
  repairCount = 0,
  onDismissRepairs
}: DrcPanelProps): React.JSX.Element {
  return (
    <div className="drc" role="dialog" aria-label="Design rule check">
      <div className="panel__head">
        <div className="panel__head-text">
          <div className="panel__head-title">Design rule check</div>
          <div className="panel__head-sub">
            {findings.length} finding{findings.length !== 1 ? 's' : ''}
          </div>
        </div>
      </div>
      {repairCount > 0 && (
        <div className="drc__repairs">
          <span
            className="drc__repairs-text"
            title="This file was migrated and/or had old references repaired when it was opened. Saving will rewrite the file."
          >
            ⚠ {repairCount} changed on load
          </span>
          {onDismissRepairs && (
            <button
              className="drc__repairs-close"
              title="Dismiss this notice"
              onClick={onDismissRepairs}
            >
              ✕
            </button>
          )}
        </div>
      )}
      {findings.length === 0 ? (
        <div className="panel__hint">No issues shown.</div>
      ) : (
        <ul className="drc__list">
          {findings.map((f, i) => {
            const firstRef = f.refs[0]
            const flowId = firstRef ? resolve(firstRef) : null
            const clickable = flowId !== null && firstRef !== undefined
            return (
              <li key={i} className={`drc__row drc__row--${f.severity}`}>
                <div className="drc__head">
                  {/* The severity word became a dot in the popover; it stays
                      readable as the dot's tooltip and its accessible name. */}
                  <span
                    className={`drc__dot drc__dot--${f.severity}`}
                    title={SEVERITY_LABEL[f.severity]}
                    aria-label={SEVERITY_LABEL[f.severity]}
                  />
                  <span className="drc__ruleid">{f.ruleId}</span>
                  <button
                    className="drc__dismiss"
                    title="Dismiss this finding"
                    onClick={() => onDismiss(f)}
                  >
                    ✕
                  </button>
                </div>
                <div
                  className="drc__message"
                  onClick={clickable ? () => onSelect(firstRef) : undefined}
                  style={{ cursor: clickable ? 'pointer' : 'default', opacity: clickable ? 1 : 0.7 }}
                  title={clickable ? `Select ${firstRef.id}` : undefined}
                >
                  {f.message}
                </div>
              </li>
            )
          })}
        </ul>
      )}
      {dismissedCount > 0 && (
        <div className="drc__footer">
          {dismissedCount} dismissed ·{' '}
          <button className="drc__reset" onClick={onReset}>
            Reset
          </button>
        </div>
      )}
    </div>
  )
}
