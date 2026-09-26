import unittest
from calc import text


class WordCountTests(unittest.TestCase):
    def test_simple(self):
        self.assertEqual(text.word_count("hello world"), 2)

    def test_extra_whitespace(self):
        self.assertEqual(text.word_count("  hello   world \n again\t"), 3)

    def test_empty(self):
        self.assertEqual(text.word_count(""), 0)
        self.assertEqual(text.word_count("   "), 0)


class SlugifyTests(unittest.TestCase):
    def test_basic(self):
        self.assertEqual(text.slugify("Hello, World!"), "hello-world")

    def test_runs_and_edges(self):
        self.assertEqual(text.slugify("  --Hello   World__v2--  "), "hello-world-v2")

    def test_empty(self):
        self.assertEqual(text.slugify(""), "")


if __name__ == "__main__":
    unittest.main()
