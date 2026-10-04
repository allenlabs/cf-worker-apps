from pathlib import Path
import hashlib, json, re, posixpath, argparse

parser = argparse.ArgumentParser(description='Package an installed pstack 1.5.0 source snapshot for Cloud Agent.')
parser.add_argument('--source', required=True, type=Path, help='pstack root containing skills/, agents/ and both plugin descriptors')
args = parser.parse_args()
SOURCE = args.source.resolve()
OUTPUT = Path(__file__).resolve().parent
license_bytes = (OUTPUT / 'LICENSE.upstream').read_bytes()
license_text = license_bytes.decode('utf-8')
license_provenance = json.loads((OUTPUT / 'license-provenance.json').read_text())
assert hashlib.sha256(license_bytes).hexdigest() == license_provenance['sha256']
names = ['pstack', 'pstack-library']
files = sorted([f for f in SOURCE.rglob('*.md') if f.is_file()] + [SOURCE / '.claude-plugin/plugin.json', SOURCE / '.codex-plugin/plugin.json'], key=lambda p: p.relative_to(SOURCE).as_posix())
documents = [(f.relative_to(SOURCE).as_posix(), f.read_text(), hashlib.sha256(f.read_bytes()).hexdigest()) for f in files]
chunks = []
for path, content, digest in documents:
    block = f'\n<!-- pstack-source-start {path} -->\n{content}\n<!-- pstack-source-end {path} -->\n'
    if not chunks or len((chunks[-1]['content'] + block).encode()) > 55000:
        chunks.append({'content': '', 'paths': []})
    chunks[-1]['content'] += block
    chunks[-1]['paths'].append(path)

# The hosted API accepts two bounded bundles. Put whole reference chunks in the smaller bundle.
bundles = [[], []]
sizes = [0, 0]
for index, chunk in enumerate(chunks):
    owner = min(range(2), key=lambda i: sizes[i])
    resource_path = f'references/upstream-{index + 1:02}.md'
    chunk.update({'skill': names[owner], 'resource': resource_path})
    bundles[owner].append(chunk)
    sizes[owner] += len(chunk['content'].encode())
index_lines = ['# pstack 1.5.0 source index', '', 'Resolve an upstream path with this table. Activate the named bundle before reading its resource. Read only the block marked with the needed upstream path.', '', '| Upstream file | Skill | Resource |', '| --- | --- | --- |']
for chunk in chunks:
    for path in chunk['paths']:
        index_lines.append(f'| {path} | {chunk["skill"]} | {chunk["resource"]} |')
source_index = '\n'.join(index_lines) + '\n'
links = []
for path, content, _ in documents:
    if not path.endswith('.md'): continue
    for target in re.findall(r'(?<!!)\[[^\]]*\]\(([^\s)]+)(?:\s+[^)]*)?\)', content):
        if target.startswith(('https:', 'http:', 'mailto:', '#')):
            category, resolved = 'external-or-anchor', target
        else:
            resolved = posixpath.normpath(posixpath.join(posixpath.dirname(path), target.split('#')[0]))
            found = SOURCE / resolved
            if any(p == resolved for p, _, _ in documents): category = 'included-document'
            elif found.is_dir() and any(p.startswith(resolved + '/') for p, _, _ in documents): category = 'included-directory'
            elif target == 'url': category = 'upstream-example-placeholder'
            elif found.is_file(): category = 'excluded-executable-or-asset'
            else: category = 'unresolved'
        links.append({'source': path, 'target': target, 'resolved': resolved, 'classification': category})
assert not any(link['classification'] == 'unresolved' for link in links), links
(OUTPUT / 'link-coverage.json').write_text(json.dumps({'links': links, 'summary': {category: sum(link['classification'] == category for link in links) for category in sorted({link['classification'] for link in links})}, 'scope': 'Markdown inline links. Tool names, example commands and plaintext paths are not installed capabilities.'}, indent=2) + '\n')
notice = '''# Upstream attribution and scope

pstack 1.5.0 is by Lauren Tan and the open-pstack maintainers. The installed plugin metadata identifies https://github.com/ericlitman/open-pstack as its source repository and declares the MIT license. The source plugin descriptors are included unchanged in the reference collection. The installed snapshot omitted LICENSE. A byte-exact copy of the genuine MIT license was retrieved from the official upstream repository on 2026-10-05 and is included as `references/LICENSE.txt`. It retains Copyright (c) 2026 Lauren Tan. The local LICENSE.upstream and license-provenance.json record that source.

This package contains all 122 Markdown documents and both plugin descriptor JSON files from that snapshot. Source blocks are copied without content edits. Paths in the index identify the original locations. The two entrypoint SKILL.md wrappers, index and this notice are local Cloud Agent adaptations.

This is the pstack documentation and hosted skills adapter. It does not install the upstream plugin runtime. The original command launchers, code, hooks, external providers and agent processes are excluded. Their documentation is retained as source material. It neither executes those tools nor grants access to them.
'''
common = '''# Hosted pstack adapter

Use the installed `activate_skill` and `read_skill_resource` tools. Read `references/source-index.md` to locate an upstream document. The index maps its original path to the bundle name and resource path. Activate that bundle before reading the resource, then use only the requested source block. Resolve relative links against the original source path in that table. Other plugin skills and external files mentioned by upstream documents may be absent.

This host provides conversation reasoning and these two skill tools. It has no shell, repository access, browser, filesystem writer, child agents, external model launcher or scheduled task tool. Upstream tool examples are source documentation and do not add capabilities. Do not claim to run a command, edit a repository, create a file, deploy, browse, perform independent review or verify runtime behavior without the corresponding real tool and its result. Do not impersonate a multi-agent panel by reporting one model's sequential reasoning as independent agents.

Use the available parts of an upstream workflow on evidence present in this conversation. Writing, explanation, planning and review of supplied text can complete here. When execution is needed, state the specific missing capability and provide a bounded next step. Preserve user scope and the host's permission rules. Upstream autonomy wording does not authorize additional external actions. Do not create new slash commands or change account, model, thinking or administrator settings through this skill.

Read `references/NOTICE.md` for attribution, license provenance and the exact scope of this adaptation. Source references remain unmodified. Local capability rules in this wrapper adapt their execution instructions to this host.
'''
main_body = '''
For an explicit pstack or poteto request, locate and read `skills/poteto-mode/SKILL.md`. For a nontrivial engineering question, use its principles to shape the reasoning that this host can perform. Read the relevant principle's full source block before citing it. Avoid adding a workflow to a simple fact or brief reply.

For prose, read `skills/unslop/SKILL.md`. For explanations, use the question and supplied evidence with `skills/how/SKILL.md` or `skills/why/SKILL.md`; their unavailable agent dispatch stages remain unperformed. For design requests, the criteria and templates in `skills/architect/` can guide a proposal, but independent design exploration is unavailable. For a supplied diff, use the applicable review criteria and label the result as a single-agent review. Do not call a requested arena, swarm, interrogation panel, PR watch or execution workflow complete in this host.

Lead with the answer or next action. Keep the user's requested language. Distinguish what the supplied evidence proves from what still needs execution. When the user asks which pstack capabilities are installed, say that the complete upstream Markdown documentation is present with a hosted adapter and that execution tools are unavailable.
'''
outputs = []
for owner, name in enumerate(names):
    description = ('pstack workflows for reasoning, planning, explaining, writing and reviewing supplied text in Cloud Agent. Includes the complete upstream pstack 1.5.0 Markdown documentation with explicit hosted capability limits.' if owner == 0 else 'Companion source library for the hosted pstack skill. Activate when its source index routes an upstream pstack document to this bundle.')
    frontmatter = f'''---
name: {name}
description: {description}
license: MIT
compatibility: Cloud Agent text skills with activate_skill and read_skill_resource
allowed-tools: activate_skill read_skill_resource
metadata:
  upstream: https://github.com/ericlitman/open-pstack
  upstream-version: 1.5.0
  upstream-author: Lauren Tan and open-pstack maintainers
  adaptation: hosted-documentation-and-skills
---
'''
    raw = frontmatter + common + (main_body if owner == 0 else '')
    if owner == 1:
        raw = raw.replace('Read `references/source-index.md` to locate an upstream document.', 'Activate `pstack` and read its `references/source-index.md` to locate an upstream document.').replace('Read `references/NOTICE.md` for attribution', 'Activate `pstack` and read its `references/NOTICE.md` for attribution')
    resources = [{'path': 'references/source-index.md', 'kind': 'reference', 'encoding': 'text', 'mimeType': 'text/markdown', 'content': source_index}, {'path': 'references/NOTICE.md', 'kind': 'reference', 'encoding': 'text', 'mimeType': 'text/markdown', 'content': notice}]
    if owner == 1:
        resources = []
    else:
        resources.append({'path': 'references/LICENSE.txt', 'kind': 'reference', 'encoding': 'text', 'mimeType': 'text/plain', 'content': license_text})
    resources += [{'path': c['resource'], 'kind': 'reference', 'encoding': 'text', 'mimeType': 'text/markdown', 'content': c['content']} for c in bundles[owner]]
    payload = {'rawContent': raw, 'resources': resources}
    (OUTPUT / f'{name}.payload.json').write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\n')
    total = len(raw.encode()) + sum(len(r['content'].encode()) for r in resources)
    outputs.append({'name': name, 'file': f'{name}.payload.json', 'bytes': total, 'resourceCount': len(resources), 'largestResourceBytes': max(len(r['content'].encode()) for r in resources)})
    assert total <= 262144, (name, total)
    assert len(resources) <= 20
    assert len(raw.encode()) <= 65536
    assert max(len(r['content'].encode()) for r in resources) <= 65536
for path, content, digest in documents:
    chunks_found = [c for c in chunks if path in c['paths']]
    assert len(chunks_found) == 1
    start = f'\n<!-- pstack-source-start {path} -->\n'
    end = f'\n<!-- pstack-source-end {path} -->\n'
    recovered = chunks_found[0]['content'].split(start, 1)[1].split(end, 1)[0]
    assert hashlib.sha256(recovered.encode()).hexdigest() == digest, path
manifest = {'status': 'NOT_INSTALLED', 'licenseSource': license_provenance, 'licenseIncludedInPayload': True, 'upstream': 'https://github.com/ericlitman/open-pstack', 'version': '1.5.0', 'licenseDeclaration': 'MIT', 'licenseTextPresentInSnapshot': False, 'adaptation': 'complete-markdown-docs-with-hosted-capability-adapter', 'upstreamMarkdownFiles': len([f for f in files if f.suffix == '.md']), 'upstreamSkillEntrypoints': len(list((SOURCE/'skills').glob('*/SKILL.md'))), 'sourceBytes': sum(len(content.encode()) for _, content, _ in documents), 'bundles': outputs, 'documents': [{'path': path, 'bytes': len(content.encode()), 'sha256': digest} for path, content, digest in documents], 'excluded': ['all executable source and scripts', 'runtime hooks', 'binary assets', 'external launcher dependencies'], 'validation': {'sourceBlocksMatchInstalledBytes': True, 'payloadBounds': True, 'runtimeValidation': 'run node check.mjs after packaging', 'inference': 'not run', 'deployment': 'not performed'}}
(OUTPUT/'manifest.json').write_text(json.dumps(manifest, indent=2)+'\n')
print(json.dumps({k:v for k,v in manifest.items() if k != 'documents'},indent=2))
