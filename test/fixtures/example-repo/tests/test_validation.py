import unittest


class ValidationTests(unittest.TestCase):
    """Refactor target: calc/validation.py must provide ensure_numbers(values)
    used by calc/stats.py (no duplicated validation left in stats.py)."""

    def test_ensure_numbers(self):
        from calc.validation import ensure_numbers
        self.assertIsNone(ensure_numbers([1, 2.5]))
        with self.assertRaises(ValueError):
            ensure_numbers([])
        with self.assertRaises(TypeError):
            ensure_numbers([True])
        with self.assertRaises(TypeError):
            ensure_numbers("12")

    def test_stats_uses_helper(self):
        import inspect
        from calc import stats
        src = inspect.getsource(stats)
        self.assertIn("ensure_numbers", src)
        self.assertNotIn("isinstance", src)


if __name__ == "__main__":
    unittest.main()
