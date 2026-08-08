"""
AI-powered WindowSpec generator.

Uses Claude to generate WindowSpecs from natural language prompts.
Falls back to templates on failure.
"""

import os
import json
import logging
from typing import TYPE_CHECKING, Optional

from models.window_spec import WindowSpec, UIElement, ActionDef
from services.spec_templates import get_fallback_template

if TYPE_CHECKING:
    from models.window_spec import WindowRecord

logger = logging.getLogger(__name__)

# System prompt for spec generation
SPEC_SYSTEM_PROMPT = """You are a WindowSpec generator for a spatial desktop application. Given a user request, output a valid WindowSpec JSON.

## Available UI Element Types

- **text**: Display text. Props: content (string, supports {{key}} interpolation), fontSize, fontWeight, color
- **input**: Text input field. Props: placeholder, key (state key to bind value to), multiline (bool), rows (number)
- **button**: Clickable button. Props: label (string), variant (primary|secondary|danger)
- **list**: Display list of items. Props: itemsKey (state key containing array), itemTemplate (default|checkbox|count)
- **table**: Display tabular data. Props: dataKey (state key), columns (array of column names)
- **panel**: Container for layout. Props: direction (row|column), gap (string), align (start|center|end)
- **stack**: Vertical stack (shorthand for panel with direction=column)

## Available Action Types

- **add_item**: Add item to a list. Config: key (list key), fromInput (optional: state key to get value from)
- **remove_item**: Remove item from list by index. Config: key (list key)
- **update_field**: Update a state field. Config: key (field key), increment (optional: number to add)
- **clear_list**: Clear all items from a list. Config: key (list key)
- **spawn_window**: Create a new window. Config: prompt (string describing new window)
- **open_details**: Open detail view. Config: template (string)

## WindowSpec Schema

```json
{
  "title": "Window Title",
  "ui": [
    {
      "type": "panel|text|input|button|list|table|stack",
      "id": "unique_id",
      "props": { ... },
      "children": [ ... ],  // optional, for panel/stack
      "actionId": "action_name"  // optional, links to actions
    }
  ],
  "actions": {
    "action_name": {
      "id": "action_name",
      "type": "add_item|remove_item|update_field|clear_list|spawn_window|open_details",
      "config": { ... }
    }
  }
}
```

## Rules

1. Output ONLY valid JSON. No markdown, no explanation, no code blocks.
2. Every UI element must have a unique `id`.
3. For input fields that should add items on Enter, set `actionId` to the add action.
4. The `key` in input props determines which state field the value is stored in.
5. Use `panel` with `direction: "column"` for vertical layouts.
6. Keep the UI simple and focused on the user's request.
7. Initialize reasonable default state values in the response if needed.

## Example

User: "Create a window to track my daily water intake"

Response:
{"title":"Water Tracker","ui":[{"type":"panel","id":"main","props":{"direction":"column","gap":"16px"},"children":[{"type":"text","id":"header","props":{"content":"Daily Water Intake","fontWeight":"bold","fontSize":"18px"}},{"type":"text","id":"count","props":{"content":"Glasses today: {{count}}","fontSize":"24px"}},{"type":"panel","id":"buttons","props":{"direction":"row","gap":"8px"},"children":[{"type":"button","id":"add","props":{"label":"+ Add Glass"},"actionId":"add_glass"},{"type":"button","id":"reset","props":{"label":"Reset","variant":"secondary"},"actionId":"reset"}]}]}],"actions":{"add_glass":{"id":"add_glass","type":"update_field","config":{"key":"count","increment":1}},"reset":{"id":"reset","type":"update_field","config":{"key":"count"}}}}
"""

DERIVE_SYSTEM_PROMPT = """You are a WindowSpec generator creating a DERIVED window that references data from a source window.

The derived window should:
1. Reference the source window's data (available via bindings, accessed as "boundData" in state)
2. Transform or visualize that data in a new way
3. NOT duplicate the source data

Available transforms that will be applied to source data:
- countDuplicates: Count occurrences of each unique item
- filterNotEmpty: Remove empty/null items
- sortAlpha: Sort items alphabetically
- groupBy: Group items by a field

The derived window's state will have:
- `boundData`: The transformed data from the source window

""" + SPEC_SYSTEM_PROMPT


def generate_spec(prompt: str, use_ai: bool = True) -> WindowSpec:
    """
    Generate a WindowSpec from a natural language prompt.

    Args:
        prompt: User's description of what the window should do
        use_ai: Whether to use AI generation (set False for testing)

    Returns:
        A validated WindowSpec
    """
    if not use_ai:
        return get_fallback_template(prompt)

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        logger.warning("ANTHROPIC_API_KEY not set, using fallback template")
        return get_fallback_template(prompt)

    try:
        import anthropic

        client = anthropic.Anthropic(api_key=api_key)

        response = client.messages.create(
            model="claude-sonnet-4-20250514",
            max_tokens=2000,
            system=SPEC_SYSTEM_PROMPT,
            messages=[{"role": "user", "content": f"Create a window for: {prompt}"}],
        )

        # Extract JSON from response
        response_text = response.content[0].text.strip()

        # Handle case where model wraps in code block
        if response_text.startswith("```"):
            lines = response_text.split("\n")
            # Remove first and last lines (code block markers)
            response_text = "\n".join(lines[1:-1])

        spec_json = json.loads(response_text)

        # Validate and return
        spec = WindowSpec.model_validate(spec_json)

        # Update title if AI didn't set one
        if spec.title == "Window Title" or not spec.title:
            # Extract a title from the prompt
            spec.title = _extract_title(prompt)

        return spec

    except json.JSONDecodeError as e:
        logger.error(f"Failed to parse AI response as JSON: {e}")
        return get_fallback_template(prompt)
    except Exception as e:
        logger.error(f"AI spec generation failed: {e}")
        return get_fallback_template(prompt)


def generate_derived_spec(
    source: "WindowRecord",
    prompt: str,
    transform: Optional[str] = None,
    use_ai: bool = True,
) -> WindowSpec:
    """
    Generate a WindowSpec that derives from a source window.

    Args:
        source: The source WindowRecord to derive from
        prompt: User's description of what the derived window should show
        transform: Optional transform to apply to source data
        use_ai: Whether to use AI generation

    Returns:
        A validated WindowSpec for the derived window
    """
    if not use_ai:
        return get_fallback_template(prompt)

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        logger.warning("ANTHROPIC_API_KEY not set, using fallback template")
        return get_fallback_template(prompt)

    try:
        import anthropic

        client = anthropic.Anthropic(api_key=api_key)

        # Build context about source window
        source_state_keys = list(source.state.data.keys())
        source_ui_types = [e.type for e in source.spec.ui]

        context = f"""Source window: "{source.spec.title}"
Source data keys: {source_state_keys}
Source UI elements: {source_ui_types}
Sample data: {json.dumps(source.state.data, default=str)[:500]}

The derived window will receive the source's data as "boundData" in its state.
{f'Transform "{transform}" will be applied to the data.' if transform else ''}

User wants: {prompt}"""

        response = client.messages.create(
            model="claude-sonnet-4-20250514",
            max_tokens=2000,
            system=DERIVE_SYSTEM_PROMPT,
            messages=[{"role": "user", "content": context}],
        )

        response_text = response.content[0].text.strip()

        if response_text.startswith("```"):
            lines = response_text.split("\n")
            response_text = "\n".join(lines[1:-1])

        spec_json = json.loads(response_text)
        spec = WindowSpec.model_validate(spec_json)

        return spec

    except Exception as e:
        logger.error(f"AI derived spec generation failed: {e}")
        return get_fallback_template(prompt)


def _extract_title(prompt: str) -> str:
    """Extract a reasonable title from a prompt."""
    # Take first few words, capitalize
    words = prompt.split()[:4]
    title = " ".join(words).title()

    # Remove trailing punctuation
    title = title.rstrip(".,!?")

    # Ensure reasonable length
    if len(title) > 30:
        title = title[:27] + "..."

    return title
