import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('taste', Path(__file__).resolve().parents[1] / 'ui-taste-count.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class UITasteReviewTests(unittest.TestCase):
    def test_new_capsule_is_not_covered_by_an_existing_review(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            reviewed = root / 'Voice.swift'
            reviewed.write_text('Capsule()')
            review = {'entries': [{'kind': 'Capsule', 'file': 'Voice.swift', 'count': 1,
                'sha256': hashlib.sha256(reviewed.read_bytes()).hexdigest()}]}
            (root / 'NewCard.swift').write_text('Capsule()')
            self.assertEqual(module.count(root, 'Capsule', r'Capsule\(\)', review), (2, 1))
            reviewed.write_text('Capsule()\nCapsule()')
            with self.assertRaisesRegex(ValueError, 'review expired'):
                module.count(root, 'Capsule', r'Capsule\(\)', review)

    def test_interpolation_source_length_is_not_displayed_prose(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'View.swift').write_text('Text("\\(veryLongIdentifierThatIsNotDisplayedOnScreen.count)")\nText("' + '文' * 40 + '")')
            self.assertEqual(module.count(root, '40字超の文言', r'Text\("[^"\n]{40,}"', {}), (1, 0))

    def test_nested_calls_and_quoted_parentheses_are_not_displayed_prose(self):
        source = r'''Text("期限: \(date(record.expiresAt)?.formatted(date: .abbreviated, time: .shortened) ?? record.expiresAt)")'''
        # A real quoted Swift argument, including ')', must not close interpolation.
        source += '\nText("日付: \\(format(value, pattern: "a ) b ( c"))")'
        self.assertEqual(module.matches(source, '40字超の文言', r'Text\("[^"]{40,}"'), [])

    def test_static_text_after_nested_interpolation_is_still_counted(self):
        source = 'Text("' + '前' * 20 + '\\(format(value, pattern: "a ) b"))' + '後' * 20 + '")'
        self.assertEqual(len(module.matches(source, '40字超の文言', r'Text\("[^"]{40,}"')), 1)
        self.assertEqual(len(module.matches('Text("' + '文' * 39 + '")', '40字超の文言', 'unused')), 0)

    def test_long_text_review_is_bound_to_current_visible_count_and_file_hash(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / 'Review.swift'
            path.write_text('Text("' + '文' * 40 + '")\nText("\\(veryLongIdentifierThatIsNotDisplayedOnScreen.count)")')
            entry = {'kind': '40字超の文言', 'file': path.name, 'count': 1,
                'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                'literal_sha256': [hashlib.sha256(('文' * 40).encode()).hexdigest()]}
            review = {'entries': [entry]}
            self.assertEqual(module.count(root, '40字超の文言', r'Text\("[^"]{40,}"', review), (1, 1))
            entry['count'] = 2
            with self.assertRaisesRegex(ValueError, 'review count invalid'):
                module.count(root, '40字超の文言', r'Text\("[^"]{40,}"', review)
            entry['count'] = 1
            path.write_text('Text("' + '別' * 40 + '")')
            entry['sha256'] = hashlib.sha256(path.read_bytes()).hexdigest()
            with self.assertRaisesRegex(ValueError, 'review text invalid'):
                module.count(root, '40字超の文言', r'Text\("[^"]{40,}"', review)

    def test_duplicate_review_cannot_count_the_same_literal_twice(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / 'Review.swift'
            path.write_text('Text("' + '文' * 40 + '")')
            entry = {'kind': '40字超の文言', 'file': path.name, 'count': 1,
                'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                'literal_sha256': [hashlib.sha256(('文' * 40).encode()).hexdigest()]}
            for other_file in [path.name, './' + path.name]:
                review = {'entries': [entry, {**entry, 'file': other_file}]}
                with self.assertRaisesRegex(ValueError, 'duplicate review'):
                    module.count(root, '40字超の文言', r'Text', review)

if __name__ == '__main__':
    unittest.main()
