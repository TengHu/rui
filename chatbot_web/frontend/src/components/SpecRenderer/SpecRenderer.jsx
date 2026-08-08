/**
 * SpecRenderer - Interprets WindowSpec JSON and renders React components
 *
 * This is the core interpreter that transforms declarative WindowSpecs
 * into a live React UI. It recursively renders the UI tree and wires
 * up actions to event handlers.
 */

import { useCallback } from 'react'
import {
  Text,
  Input,
  Button,
  List,
  Table,
  Panel,
  Stack,
} from '../Primitives'
import './SpecRenderer.css'

// Map spec types to React components
const COMPONENT_MAP = {
  text: Text,
  input: Input,
  button: Button,
  list: List,
  table: Table,
  panel: Panel,
  stack: Stack,
}

export function SpecRenderer({ spec, state, onAction, onStateChange }) {
  /**
   * Recursively render a UI element from the spec
   */
  const renderElement = useCallback((element) => {
    if (!element || !element.type) {
      console.warn('Invalid element:', element)
      return null
    }

    const Component = COMPONENT_MAP[element.type]

    if (!Component) {
      console.warn(`Unknown element type: ${element.type}`)
      return (
        <div key={element.id} className="spec-unknown">
          Unknown: {element.type}
        </div>
      )
    }

    // Build props from element definition
    const props = {
      key: element.id,
      ...element.props,
      state,
      onAction,
      onStateChange,
    }

    // Handle special prop mappings
    if (element.props?.key) {
      props.stateKey = element.props.key
    }

    // Pass actionId if present
    if (element.actionId) {
      props.actionId = element.actionId
    }

    // Render children recursively for container components
    if (element.children && element.children.length > 0) {
      return (
        <Component {...props}>
          {element.children.map(child => renderElement(child))}
        </Component>
      )
    }

    return <Component {...props} />
  }, [state, onAction, onStateChange])

  if (!spec || !spec.ui) {
    return (
      <div className="spec-renderer-empty">
        No UI specification
      </div>
    )
  }

  return (
    <div className="spec-renderer">
      {spec.ui.map(element => renderElement(element))}
    </div>
  )
}

export default SpecRenderer
