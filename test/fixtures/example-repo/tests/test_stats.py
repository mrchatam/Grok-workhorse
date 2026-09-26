import unittest
from calc import stats


class StatsTests(unittest.TestCase):
    def test_mean(self):
        self.assertEqual(stats.mean([1, 2, 3]), 2)

    def test_median(self):
        self.assertEqual(stats.median([3, 1, 2]), 2)
        self.assertEqual(stats.median([4, 1, 2, 3]), 2.5)

    def test_errors(self):
        with self.assertRaises(ValueError):
            stats.mean([])
        with self.assertRaises(TypeError):
            stats.median([1, "x"])
        with self.assertRaises(TypeError):
            stats.mean("123")


if __name__ == "__main__":
    unittest.main()
