"""
Transform functions for derived window data.

These are applied to source window data when resolving bindings.
"""

from typing import Dict, Any, List, Callable
from collections import Counter

# Type for transform functions
TransformFn = Callable[[Any], Any]


def count_duplicates(items: List[Any]) -> List[Dict[str, Any]]:
    """
    Count occurrences of each unique item.

    Returns list of {item, count} dicts sorted by count descending.
    """
    if not items:
        return []

    # Handle both simple values and dicts
    if items and isinstance(items[0], dict):
        # For dicts, use a string key
        counter = Counter(str(item) for item in items)
    else:
        counter = Counter(items)

    return [
        {"item": item, "count": count}
        for item, count in counter.most_common()
    ]


def filter_not_empty(items: List[Any]) -> List[Any]:
    """Remove empty, null, or whitespace-only items."""
    result = []
    for item in items:
        if item is None:
            continue
        if isinstance(item, str) and not item.strip():
            continue
        if isinstance(item, (list, dict)) and not item:
            continue
        result.append(item)
    return result


def sort_alphabetically(items: List[Any]) -> List[Any]:
    """Sort items alphabetically (case-insensitive)."""
    return sorted(items, key=lambda x: str(x).lower())


def sort_by_count(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Sort items by their 'count' field descending."""
    return sorted(items, key=lambda x: x.get("count", 0), reverse=True)


def group_by_field(items: List[Dict], field: str = "category") -> Dict[str, List]:
    """
    Group items by a field value.

    Args:
        items: List of dicts
        field: Field name to group by

    Returns:
        Dict mapping field values to lists of items
    """
    result: Dict[str, List] = {}
    for item in items:
        if not isinstance(item, dict):
            continue
        key = str(item.get(field, "unknown"))
        result.setdefault(key, []).append(item)
    return result


def unique_items(items: List[Any]) -> List[Any]:
    """Return only unique items, preserving order."""
    seen = set()
    result = []
    for item in items:
        # Handle unhashable types
        key = str(item) if isinstance(item, (dict, list)) else item
        if key not in seen:
            seen.add(key)
            result.append(item)
    return result


def first_n(items: List[Any], n: int = 10) -> List[Any]:
    """Return first N items."""
    return items[:n]


def last_n(items: List[Any], n: int = 10) -> List[Any]:
    """Return last N items."""
    return items[-n:] if items else []


def reverse_list(items: List[Any]) -> List[Any]:
    """Reverse the list."""
    return list(reversed(items))


def flatten(items: List[List[Any]]) -> List[Any]:
    """Flatten a list of lists."""
    result = []
    for item in items:
        if isinstance(item, list):
            result.extend(item)
        else:
            result.append(item)
    return result


def sum_values(items: List[Any]) -> float:
    """Sum numeric values in the list."""
    total = 0.0
    for item in items:
        if isinstance(item, (int, float)):
            total += item
        elif isinstance(item, dict) and "value" in item:
            try:
                total += float(item["value"])
            except (ValueError, TypeError):
                pass
    return total


def average_values(items: List[Any]) -> float:
    """Calculate average of numeric values."""
    if not items:
        return 0.0

    values = []
    for item in items:
        if isinstance(item, (int, float)):
            values.append(item)
        elif isinstance(item, dict) and "value" in item:
            try:
                values.append(float(item["value"]))
            except (ValueError, TypeError):
                pass

    return sum(values) / len(values) if values else 0.0


def identity(data: Any) -> Any:
    """Return data unchanged."""
    return data


# Transform registry
TRANSFORMS: Dict[str, TransformFn] = {
    "identity": identity,
    "countDuplicates": count_duplicates,
    "filterNotEmpty": filter_not_empty,
    "sortAlpha": sort_alphabetically,
    "sortByCount": sort_by_count,
    "groupBy": group_by_field,
    "unique": unique_items,
    "firstN": first_n,
    "lastN": last_n,
    "reverse": reverse_list,
    "flatten": flatten,
    "sum": sum_values,
    "average": average_values,
}


def apply_transform(
    transform_name: str,
    data: Any,
    **kwargs
) -> Any:
    """
    Apply a named transform to data.

    Args:
        transform_name: Name of transform from TRANSFORMS registry
        data: Data to transform
        **kwargs: Additional arguments for the transform

    Returns:
        Transformed data, or original data if transform not found
    """
    fn = TRANSFORMS.get(transform_name)
    if not fn:
        return data

    try:
        if kwargs:
            return fn(data, **kwargs)
        return fn(data)
    except Exception as e:
        # Log but don't fail - return original data
        import logging
        logging.warning(f"Transform '{transform_name}' failed: {e}")
        return data


def get_available_transforms() -> List[str]:
    """Return list of available transform names."""
    return list(TRANSFORMS.keys())
