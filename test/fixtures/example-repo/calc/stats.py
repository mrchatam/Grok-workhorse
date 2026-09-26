"""Statistics helpers (validation logic is duplicated on purpose; see README)."""


def mean(values):
    if not isinstance(values, (list, tuple)):
        raise TypeError("values must be a list or tuple")
    if len(values) == 0:
        raise ValueError("values must not be empty")
    for v in values:
        if not isinstance(v, (int, float)) or isinstance(v, bool):
            raise TypeError("all values must be numbers")
    return sum(values) / len(values)


def median(values):
    if not isinstance(values, (list, tuple)):
        raise TypeError("values must be a list or tuple")
    if len(values) == 0:
        raise ValueError("values must not be empty")
    for v in values:
        if not isinstance(v, (int, float)) or isinstance(v, bool):
            raise TypeError("all values must be numbers")
    s = sorted(values)
    mid = len(s) // 2
    if len(s) % 2:
        return s[mid]
    return (s[mid - 1] + s[mid]) / 2
