import type { Id } from '../model/schema'

export type Severity = 'error' | 'warning' | 'info'

export interface EntityRef {
  kind:
    | 'wire'
    | 'cavity'
    | 'connector'
    | 'splice'
    | 'segment'
    | 'branchPoint'
    | 'cable'
    | 'freeTerminal'
    | 'sleeving'
    | 'twist'
  id: Id
}

export interface Finding {
  ruleId: string
  severity: Severity
  message: string
  refs: EntityRef[]
}
