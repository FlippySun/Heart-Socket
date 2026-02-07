const fs = require('fs');
const vm = require('vm');
const src = fs.readFileSync('dist/extension.js', 'utf8');
// Find all script blocks and validate the largest one (the Stats webview)
const re = /<script>([\s\S]*?)<\/script>/g;
let match, biggest = '';
while ((match = re.exec(src)) !== null) {
  if (match[1].length > biggest.length) biggest = match[1];
}
if (!biggest) { console.error('No script block found'); process.exit(1); }
try {
  new vm.Script(biggest, { filename: 'webview-stats.js' });
  const lines = biggest.split('\n').length;
  console.log('JS SYNTAX VALID! (' + lines + ' lines, ' + biggest.length + ' chars)');
} catch(e) {
  console.error('JS SYNTAX ERROR:', e.message);
  process.exit(1);
}
