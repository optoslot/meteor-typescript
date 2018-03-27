var fs = Npm.require("fs");
var fse = Npm.require("fs-extra");
var path = Npm.require("path");
var typescript = Npm.require("typescript");

var sourceMapReferenceLineRegExp = new RegExp("//# sourceMappingURL=.*$", "m");

function archMatches(arch, pattern) {
	if (arch.substr(0, pattern.length) != pattern)
		return false;

	return arch.length == pattern.length || arch[pattern.length] == ".";
}

function compile(input) {
	var result = {
		source: "",
		sourceMap: "",
		errors: [],
	};

	var target = 1; // ES5
	if (archMatches(input.arch, "os"))
		target = 4; // ES2017

	var options = {
		out: "out.js",
		target: target,
		sourceMap: true,
		alwaysStrict: true,
		removeComments: true,
		noEmitOnError: true,
		noStrictGenericChecks: true,
		exclude: [ "node_modules" ],
		types: [],
	};

	var compilerHost = typescript.createCompilerHost(options);
	compilerHost.writeFile = function(fileName, data, writeByteOrderMark, onError) {
		if (fileName == "out.js")
			result.source = data;
		else
			result.sourceMap = data;
	};

	var program = typescript.createProgram(input.fullPaths, options, compilerHost);
	var emitResult = program.emit();

	var allDiagnostics = typescript.getPreEmitDiagnostics(program).concat(emitResult.diagnostics);

	allDiagnostics.forEach(function(diagnostic) {
		var lineAndCharacter = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
		var line = lineAndCharacter.line + 1;
		var character = lineAndCharacter.character + 1;
		var diagnosticCategory = typescript.DiagnosticCategory[diagnostic.category];
		var message = typescript.flattenDiagnosticMessageText(diagnostic.messageText, "\n");

		result.errors.push({
			message: diagnosticCategory + " TS" + diagnostic.code + ": " + message,
			sourcePath: diagnostic.file.fileName,
			line: line,
			column: character
		});
	});

	if (!emitResult.emitSkipped) {
		// Remove source map reference line from generated js file.
		// Meteor sets up source map through HTTP response header instead.
		// FIXME: Should be an option for TypeScript compiler.
		result.source = result.source.replace(sourceMapReferenceLineRegExp, "");

		// FIXME: Embed sources directly in the source map, as there is no way to make Meteor serve them as files.
		sourceMapObject = JSON.parse(result.sourceMap);
		sourceMapObject.file = input.pathForSourceMap;
		sourceMapObject.sourcesContent = [];
		sourceMapObject.sources.forEach(function(sourcePath) {
			var fullPath = path.join(process.cwd(), sourcePath);
			var sourceContent = fs.readFileSync(fullPath, { encoding: "utf8" });
			sourceMapObject.sourcesContent.push(sourceContent);
		});
		result.sourceMap = JSON.stringify(sourceMapObject);
	}

	return result;
}

// Cache persists across plugin invocations.
this.cache = this.cache || {};

function cachedCompile(input) {
	var key = "";

	input.fullPaths && input.fullPaths.forEach(function(fullPath) {
		key += fullPath;
		key += ":";
		key += fs.statSync(fullPath).mtime.getTime();
		key += ":";
	});

	var archCache = cache[input.arch] || {};

	if (archCache.key !== key) {
		archCache.key = key;
		archCache.result = compile(input);
	}

	cache[input.arch] = archCache;
	return archCache.result;
}

/* << ADD */
function _pushStringToCharArray(charArr, str) {
	for (let i = 0; i < str.length; i++) {
		charArr.push(str.charAt(i));
	}
}

class SourcePlume {
	_chars;

	constructor() {
		this._chars = [];
	}

	pushString(str) {
		_pushStringToCharArray(this._chars, str);
	}

	endsWith(strOrArr) {
		if (typeof strOrArr === 'string') {
			return this.endsWithString(strOrArr);
		} else {
			for (let str of strOrArr) {
				if (this.endsWithString(str)) {
					return true;
				}
			}
			return false;
		}
	}

	endsWithString(str) {
		if (this._chars.length < str.length) {
			return false;
		}

		for (let strIndex = str.length, charsIndex = this._chars.length; --strIndex >= 0 && --charsIndex >= 0;) {
			if (str.charAt(strIndex) !== this._chars[charsIndex]) {
				return false;
			}
		}

		return true;
	}
}

class SourceBuffer {
	_chars;

	constructor() {
		this._chars = [];
	}

	pushString(str) {
		_pushStringToCharArray(this._chars, str);
	}

	changeSizeWithDelta(delta) {
		this._chars.length += delta;
	}

	buildString() {
		return this._chars.join('');
	}
}

const ProcessArchState = {
	Any: 'Any',
	Client: 'Client',
	Server: 'Server'
};

const ProcessArchSubState = {
	SingleLineComment: 'LineComment',
	MultiLineComment: 'MultiLineComment',
	Code: 'Code'
};

function tsPathToMtsPath(tsPath, arch) {
	const normalizedTsPath = tsPath.replace(new RegExp(':', 'g'), '_');
	const mtsPath = path.join(process.cwd(), 'packages', '_temp', arch, normalizedTsPath);
	const mtsDirpath = path.dirname(mtsPath);
	fse.ensureDirSync(mtsDirpath);
	return mtsPath;
}

class SourceProcessor {
	constructor() {
	}

	processSource(source, inputPath, arch) {
		const inputPathComponents = inputPath.split(path.sep);
		if (inputPathComponents.length > 0) {
			if (inputPathComponents[0] === 'client') {
				return source;
			} else if (inputPathComponents[0] === 'server') {
				return source;
			}
		}

		const desiredArchState = arch === 'os' ? ProcessArchState.Server : ProcessArchState.Client;

		const sourcePlume = new SourcePlume();
		const sourceBuffer = new SourceBuffer();
		let state = ProcessArchState.Any;
		let subState = ProcessArchSubState.Code;
		let brackets;

		for (let i = 0; i < source.length; i++) {
			sourcePlume.pushString(source.charAt(i));
			sourceBuffer.pushString(source.charAt(i));

			switch (state) {
				case ProcessArchState.Any: {
					if (sourcePlume.endsWith(SourceProcessorWords.MeteorIsClientBegin)) {
						state = ProcessArchState.Client;
						subState = ProcessArchSubState.Code;
						brackets = 1;
						sourceBuffer.changeSizeWithDelta(-SourceProcessorWords.MeteorIsClientBegin.length);
					}
					else if (sourcePlume.endsWith(SourceProcessorWords.MeteorIsServerBegin)) {
						state = ProcessArchState.Server;
						subState = ProcessArchSubState.Code;
						brackets = 1;
						sourceBuffer.changeSizeWithDelta(-SourceProcessorWords.MeteorIsServerBegin.length);
					}
					break;
				} // case
				case ProcessArchState.Client:
				case ProcessArchState.Server: {
					if (subState === ProcessArchSubState.SingleLineComment) {
						if (sourcePlume.endsWith(SourceProcessorWords.CloseSingleLineComment)) {
							subState = ProcessArchSubState.Code;
						}
					}
					else if (subState === ProcessArchSubState.MultiLineComment) {
						if (sourcePlume.endsWith(SourceProcessorWords.CloseMultiLineComment)) {
							subState = ProcessArchSubState.Code;
						}
					}
					else if (subState === ProcessArchSubState.Code) {
						if (sourcePlume.endsWith(SourceProcessorWords.OpenSinleLineComment)) {
							subState = ProcessArchSubState.SingleLineComment;
						}
						else if (sourcePlume.endsWith(SourceProcessorWords.OpenMultiLineComment)) {
							subState = ProcessArchSubState.MultiLineComment;
						}
						else if (sourcePlume.endsWith(SourceProcessorWords.OpenBracket)) {
							brackets++;
						}
						else if (sourcePlume.endsWith(SourceProcessorWords.CloseBracket)) {
							brackets--;
							if (brackets <= 0) {
								sourceBuffer.changeSizeWithDelta(-SourceProcessorWords.CloseBracket.length);
								state = ProcessArchState.Any;
								subState = ProcessArchSubState.Code;
								break;
							}
						}
					}
					if (state !== desiredArchState) {
						sourceBuffer.changeSizeWithDelta(-1);
					}
					break;
				} // case
			} // switch
		} // for

		return sourceBuffer.buildString();
	} // method
}

const SourceProcessorWords = {
	MeteorIsClientBegin: 'if (Meteor.isClient) {',
	MeteorIsServerBegin: 'if (Meteor.isServer) {',
	OpenBracket: '{',
	CloseBracket: '}',
	OpenSinleLineComment: '//',
	CloseSingleLineComment: ['\r', '\n'],
	OpenMultiLineComment: '/*',
	CloseMultiLineComment: '*/'
};
/* ADD >> */

var packageName = null;
var compileInput = {};

Plugin.registerSourceHandler("ts", function(compileStep) {
	if (compileStep.fileOptions && compileStep.fileOptions.transpile === false)
		return;

	if (packageName != compileStep.packageName) {
		packageName = compileStep.packageName;
		compileInput = {};
	}

	/* << ADD */
	let compileStepPath = compileStep.fullInputPath;
	let compileStepProcessedPath = tsPathToMtsPath(compileStepPath, compileStep.arch);
	let compileStepSource = fs.readFileSync(compileStepPath, { encoding: 'utf8' });
	let compileStepProcessedSource = (new SourceProcessor()).processSource(compileStepSource, compileStep.inputPath, compileStep.arch);
	fs.writeFileSync(compileStepProcessedPath, compileStepProcessedSource, { encoding: 'utf8' });
	/* ADD >> */

	compileInput.fullPaths = compileInput.fullPaths || [];
	compileInput.fullPaths.push(
		/* << REMOVE
		compileStep.fullInputPath
		REMOVE >> */

		/* << ADD */
		compileStepProcessedPath
		/* ADD >> */
	);
});

Plugin.registerSourceHandler("ts-build", function(compileStep) {
	compileInput.arch = compileStep.arch;
	compileInput.pathForSourceMap = compileStep.pathForSourceMap;

	var result = cachedCompile(compileInput);

	result.errors.forEach(function(error) {
		compileStep.error(error);
	});

	if (result.source) {
		compileStep.addJavaScript({
			path: compileStep.inputPath + ".js",
			sourcePath: compileStep.inputPath,
			data: result.source,
			sourceMap: result.sourceMap,
		});
	}

	compileInput = {};
});
