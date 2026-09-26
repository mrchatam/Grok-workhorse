import unittest
from calc import core


class CoreTests(unittest.TestCase):
    def test_add(self):
        self.assertEqual(core.add(2, 3), 5)

    def test_subtract(self):
        self.assertEqual(core.subtract(5, 3), 2)

    def test_multiply(self):
        self.assertEqual(core.multiply(4, 3), 12)
        self.assertEqual(core.multiply(-2, 3), -6)

    def test_divide(self):
        self.assertAlmostEqual(core.divide(7, 2), 3.5)
        self.assertIsInstance(core.divide(4, 2), float)

    def test_divide_by_zero(self):
        with self.assertRaisesRegex(ZeroDivisionError, "cannot divide by zero"):
            core.divide(1, 0)


if __name__ == "__main__":
    unittest.main()
