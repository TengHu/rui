"""
Fallback templates for WindowSpec generation.

When AI generation fails or for common patterns, these templates
provide reliable starting points.
"""

from models.window_spec import WindowSpec, UIElement, ActionDef


def _feedback_collector() -> WindowSpec:
    """Template for collecting list items (feedback, todos, etc.)."""
    return WindowSpec(
        title="Feedback Collector",
        ui=[
            UIElement(
                type="panel",
                id="main",
                props={"direction": "column"},
                children=[
                    UIElement(
                        type="input",
                        id="input",
                        props={
                            "placeholder": "Enter feedback...",
                            "key": "currentInput",
                        },
                        actionId="add_item",
                    ),
                    UIElement(
                        type="button",
                        id="add_btn",
                        props={"label": "Add"},
                        actionId="add_item",
                    ),
                    UIElement(
                        type="list",
                        id="items_list",
                        props={"itemsKey": "items"},
                    ),
                ],
            )
        ],
        actions={
            "add_item": ActionDef(
                id="add_item",
                type="add_item",
                config={"key": "items", "fromInput": "currentInput"},
            ),
            "remove_item": ActionDef(
                id="remove_item",
                type="remove_item",
                config={"key": "items"},
            ),
        },
    )


def _counter() -> WindowSpec:
    """Template for a simple counter."""
    return WindowSpec(
        title="Counter",
        ui=[
            UIElement(
                type="panel",
                id="main",
                props={"direction": "column", "align": "center"},
                children=[
                    UIElement(
                        type="text",
                        id="count_display",
                        props={"content": "{{count}}", "fontSize": "48px"},
                    ),
                    UIElement(
                        type="panel",
                        id="buttons",
                        props={"direction": "row", "gap": "8px"},
                        children=[
                            UIElement(
                                type="button",
                                id="dec_btn",
                                props={"label": "-"},
                                actionId="decrement",
                            ),
                            UIElement(
                                type="button",
                                id="inc_btn",
                                props={"label": "+"},
                                actionId="increment",
                            ),
                        ],
                    ),
                ],
            )
        ],
        actions={
            "increment": ActionDef(
                id="increment",
                type="update_field",
                config={"key": "count", "increment": 1},
            ),
            "decrement": ActionDef(
                id="decrement",
                type="update_field",
                config={"key": "count", "increment": -1},
            ),
        },
    )


def _todo_list() -> WindowSpec:
    """Template for a todo list with checkboxes."""
    return WindowSpec(
        title="Todo List",
        ui=[
            UIElement(
                type="panel",
                id="main",
                props={"direction": "column"},
                children=[
                    UIElement(
                        type="input",
                        id="input",
                        props={
                            "placeholder": "Add a task...",
                            "key": "currentInput",
                        },
                        actionId="add_todo",
                    ),
                    UIElement(
                        type="list",
                        id="todos",
                        props={
                            "itemsKey": "todos",
                            "itemTemplate": "checkbox",
                        },
                    ),
                ],
            )
        ],
        actions={
            "add_todo": ActionDef(
                id="add_todo",
                type="add_item",
                config={"key": "todos", "fromInput": "currentInput"},
            ),
            "remove_todo": ActionDef(
                id="remove_todo",
                type="remove_item",
                config={"key": "todos"},
            ),
        },
    )


def _data_table() -> WindowSpec:
    """Template for displaying tabular data."""
    return WindowSpec(
        title="Data Table",
        ui=[
            UIElement(
                type="panel",
                id="main",
                props={"direction": "column"},
                children=[
                    UIElement(
                        type="table",
                        id="data_table",
                        props={
                            "dataKey": "rows",
                            "columns": ["Name", "Value"],
                        },
                    ),
                ],
            )
        ],
        actions={},
    )


def _issue_counts() -> WindowSpec:
    """Template for showing counts/aggregations (derived window)."""
    return WindowSpec(
        title="Issue Counts",
        ui=[
            UIElement(
                type="panel",
                id="main",
                props={"direction": "column"},
                children=[
                    UIElement(
                        type="text",
                        id="title",
                        props={"content": "Repeated Issues", "fontWeight": "bold"},
                    ),
                    UIElement(
                        type="list",
                        id="counts",
                        props={
                            "itemsKey": "counts",
                            "itemTemplate": "count",
                        },
                    ),
                ],
            )
        ],
        actions={
            "view_details": ActionDef(
                id="view_details",
                type="spawn_window",
                config={"prompt": "Show details for {{selected}}"},
            ),
        },
    )


def _notes() -> WindowSpec:
    """Template for a simple notes/text area window."""
    return WindowSpec(
        title="Notes",
        ui=[
            UIElement(
                type="panel",
                id="main",
                props={"direction": "column"},
                children=[
                    UIElement(
                        type="input",
                        id="notes_input",
                        props={
                            "placeholder": "Write your notes...",
                            "key": "content",
                            "multiline": True,
                            "rows": 10,
                        },
                    ),
                ],
            )
        ],
        actions={},
    )


# Template registry
TEMPLATES = {
    "feedback_collector": _feedback_collector,
    "counter": _counter,
    "todo_list": _todo_list,
    "data_table": _data_table,
    "issue_counts": _issue_counts,
    "notes": _notes,
}


def get_fallback_template(prompt: str) -> WindowSpec:
    """
    Return best matching template based on prompt keywords.

    Args:
        prompt: User's natural language prompt

    Returns:
        A WindowSpec from the template library
    """
    prompt_lower = prompt.lower()

    # Match keywords to templates
    if any(w in prompt_lower for w in ["count", "counter", "increment", "number"]):
        return TEMPLATES["counter"]()

    if any(w in prompt_lower for w in ["todo", "task", "checklist"]):
        return TEMPLATES["todo_list"]()

    if any(w in prompt_lower for w in ["table", "data", "rows", "columns"]):
        return TEMPLATES["data_table"]()

    if any(w in prompt_lower for w in ["repeated", "duplicate", "count", "aggregate"]):
        return TEMPLATES["issue_counts"]()

    if any(w in prompt_lower for w in ["note", "notes", "text", "write"]):
        return TEMPLATES["notes"]()

    # Default: feedback collector (most versatile)
    if any(w in prompt_lower for w in ["feedback", "collect", "list", "items", "input"]):
        return TEMPLATES["feedback_collector"]()

    # Ultimate default
    return TEMPLATES["feedback_collector"]()
