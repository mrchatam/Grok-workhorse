"""Text helpers."""


def word_count(text):
    """Return the number of whitespace-separated words in text."""
    return len(text.split(" "))


def slugify(text):
    """Lowercase text, replace runs of non-alphanumeric characters with a single '-',
    and strip leading/trailing '-'. Example: "Hello, World!" -> "hello-world"."""
    raise NotImplementedError("TODO: implement slugify")
