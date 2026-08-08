/**
 * Stack primitive - vertical stack of elements (shorthand for Panel)
 *
 * Props from spec:
 * - gap: string
 * - align: "start" | "center" | "end" | "stretch"
 */

import { Panel } from './Panel'

export function Stack({ gap = '8px', align = 'stretch', children }) {
  return (
    <Panel direction="column" gap={gap} align={align}>
      {children}
    </Panel>
  )
}
