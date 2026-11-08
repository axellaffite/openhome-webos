// Load the launcher's browser scripts into a sandbox so their plain functions can be tested in Node.
//
// The files are classic scripts that share one global scope, so they are run, in the order
// given, in one vm context. Their top level only declares things and registers a
// DOMContentLoaded listener, which the stub document below accepts and ignores: nothing that
// touches the page runs. Top-level const/let are not properties of the context, so read and
// write them with ctx.run("name").
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = path.join(__dirname, "..", "src", "js");

function load(files, globals = {}) {
	const sandbox = {
		console,
		Intl,
		document: { addEventListener() {} },
		...globals,
	};
	sandbox.window = sandbox;
	const context = vm.createContext(sandbox);
	files.forEach((file) => {
		const code = fs.readFileSync(path.join(SRC, file), "utf8");
		vm.runInContext(code, context, { filename: file });
	});
	return {
		run: (code) => vm.runInContext(code, context),
		global: sandbox,
	};
}

module.exports = { load };
