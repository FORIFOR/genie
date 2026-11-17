"""Count the existing lint patterns, with content-bound reviewed additions."""
import hashlib
import json
from collections import Counter
from pathlib import Path
import re
import sys

def _interpolation_end(source, index):
    depth = 1
    while index < len(source):
        if source[index] == '"':
            index, _ = _quoted_text(source, index + 1)
            continue
        if source[index] == '(':
            depth += 1
        elif source[index] == ')':
            depth -= 1
            if depth == 0:
                return index + 1
        index += 1
    raise ValueError('unterminated Swift string interpolation')

def _quoted_text(source, index):
    visible = []
    while index < len(source):
        if source[index] == '"':
            return index + 1, ''.join(visible)
        if source.startswith('\\(', index):
            index = _interpolation_end(source, index + 2)
            continue
        if source[index] == '\\' and index + 1 < len(source):
            visible.append(source[index:index + 2])
            index += 2
            continue
        visible.append(source[index])
        index += 1
    raise ValueError('unterminated Swift Text string')

def matches(source, name, pattern):
    if name != '40字超の文言':
        return re.findall(pattern, source)
    # Interpolated code may contain nested calls and quoted arguments. Regex up
    # to the first ')' (or first quote) mistakes the remainder for visible prose.
    # Count only static segments of the same ordinary Text("...") literals.
    literals = [_quoted_text(source, start.end())[1]
                for start in re.finditer(r'Text\("', source)]
    return [literal for literal in literals if len(literal) >= 40]

def count(root, name, pattern, review):
    total = 0
    for path in root.rglob('*.swift'):
        if path.name in ('SelfTest.swift', 'UIGeometry.swift', 'UIDiffImage.swift'):
            continue
        total += len(matches(path.read_text(), name, pattern))
    accepted = 0
    reviewed_files = set()
    for entry in review.get('entries', []):
        if entry['kind'] != name:
            continue
        path = root / entry['file']
        identity = path.resolve()
        if identity in reviewed_files:
            raise ValueError(f"duplicate review: {entry['file']}")
        reviewed_files.add(identity)
        if hashlib.sha256(path.read_bytes()).hexdigest() != entry['sha256']:
            raise ValueError(f"review expired: {entry['file']}")
        if len(matches(path.read_text(), name, pattern)) < entry['count']:
            raise ValueError(f"review count invalid: {entry['file']}")
        if name == '40字超の文言':
            reviewed = entry.get('literal_sha256', [])
            available = Counter(hashlib.sha256(text.encode()).hexdigest()
                                for text in matches(path.read_text(), name, pattern))
            if len(reviewed) != entry['count']:
                raise ValueError(f"review text invalid: {entry['file']}")
            for digest in reviewed:
                if available[digest] == 0:
                    raise ValueError(f"review text invalid: {entry['file']}")
                available[digest] -= 1
        accepted += entry['count']
    return total, accepted

if __name__ == '__main__':
    root, name, pattern, review = sys.argv[1:]
    try:
        total, accepted = count(Path(root), name, pattern, json.loads(Path(review).read_text()))
        print(total - accepted)
        if accepted:
            print(f'  {name}: actual={total}, reviewed additions={accepted} (content-bound)', file=sys.stderr)
    except (ValueError, OSError) as error:
        print(error, file=sys.stderr)
        sys.exit(1)
