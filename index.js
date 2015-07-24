'use strict'
var path = require('path'),
    gutil = require('gulp-util'),
    through = require('through2'),
    glob = require('glob'),
    handlebar = require('handlebars'),
    fs = require('fs'),
    execFile = require('child_process').execFile,
    requireUncached = require('require-uncached');

/*
 * Global variables
 *
 * gulpOptions: object of options passed in through Gulp
 * jasmineCSS: string path to the jasmine.css file for the specRunner.html
 * jasmineJS: array of string paths to JS needed for the specRunner.html
 * specHtml: string path to the tmp specRunner.html to be written out to
 * specRunner: string path to the specRunner JS file needed in the specRunner.html
 **/
var gulpOptions = {},
    jasmineCss,
    jasmineJs,
    vendorJs = [],
    specHtml = path.join(__dirname, '/lib/specRunner.html'),
    specRunner = path.join(__dirname, '/lib/specRunner.js'),
    jasmineRunner = path.join(__dirname, '/lib/jasmine-runner.js'),
    pluginName = 'gulp-jasmine-phantom';


function configJasmine(version) {
    version = version || '2.0';
    var directory = path.join(__dirname, '/vendor/jasmine-' + version);
    jasmineCss = path.join(directory,  '/jasmine.css');
    jasmineJs = [
        path.join(directory, '/jasmine.js'),
        path.join(directory, '/jasmine-html.js'),
        path.join(directory, '/console.js'),
        path.join(directory, '/boot.js')
    ];
}

/**
  * Removes the specRunner.html file
  **/
function cleanup(path) {
  fs.unlink(path);
}

/**
  * Executes Phantom with the specified arguments
  * 
  * childArguments: Array of options to pass Phantom
  * [jasmine-runner.js, specRunner.html]
  **/
function runPhantom(childArguments, onComplete) {
    execFile((process.platform === 'win32' ? 'phantomjs.cmd' : 'phantomjs'), childArguments, function(error, stdout, stderr) {
        var success = null;

        if (error !== null) {
            success = new gutil.PluginError(pluginName, 'Tests contained failures. Check logs for details.');
        }

        if (stderr !== '') {
            gutil.log('gulp-jasmine-phantom: Failed to open test runner ' + gutil.colors.blue(childArguments[1]));
            gutil.log(gutil.colors.red('error: '), stderr);
            success = new gutil.PluginError(pluginName, 'Failed to open test runner ' + gutil.colors.blue(childArguments[1]));
        }

        if (gulpOptions.specHtml === undefined && (gulpOptions.keepRunner === undefined || gulpOptions.keepRunner === false)) {
            cleanup(childArguments[1]);
        }

        console.log(stdout);
        onComplete(success);
    });
}

/**
 * Reads in the handlebar template and creates a data HTML object in memory to create
 *
 * options: list of options that can be passed to the function
 *  files: paths to files being tested
 *  onComplete: callback to call when everything is done
 **/
function compileRunner(options) {
    var filePaths = options.files || [],
        onComplete = options.onComplete || {};
    fs.readFile(path.join(__dirname, '/lib/specRunner.handlebars'), 'utf8', function(error, data) {
        if (error) {
            throw error;
        }

        var vendorScripts = gulpOptions.vendor;

        if (vendorScripts) {
            if (typeof vendorScripts === 'string') {
                vendorScripts = [vendorScripts];
            }

            vendorScripts.forEach(function(fileGlob) {
                if (fileGlob.match(/^http/)) {
                    vendorJs.push(fileGlob);
                } else {
                    glob.sync(fileGlob).forEach(function(newFile) {
                        vendorJs.push(path.join(process.cwd(), newFile));
                    });
                }
            });
        }
        //// Create the compiled version of the specRunner from Handlebars
        var specData = handlebar.compile(data),
            specCompiled = specData({
                files: filePaths,
                jasmine_css: jasmineCss,
                jasmine_js: jasmineJs,
                vendor_js: vendorJs,
                spec_runner: specRunner
            });


        if(gulpOptions.keepRunner !== undefined && typeof gulpOptions.keepRunner === 'string') {
            specHtml = path.join(path.resolve(gulpOptions.keepRunner), '/specRunner.html');
        }

        fs.writeFile(specHtml, specCompiled , function(error) {
            if (error) {
                throw error;
            }

            if(gulpOptions.integration) {
                var childArgs = [
                    jasmineRunner,
                    specHtml,
                    JSON.stringify(gulpOptions)
                ];
                runPhantom(childArgs, onComplete);
            } else {
                onComplete(null);
            }
        });
    });
}

module.exports = function (options) {
    var filePaths = [],
        miniJasmineLib = requireUncached('minijasminenode2'),
        terminalReporter = require('./lib/terminal-reporter.js').TerminalReporter;


    gulpOptions = options || {};

    //// add any additional reporters
    if ('reporters' in gulpOptions) {
        for (var i = 0; i < gulpOptions.reporters.length; i++) {
            miniJasmineLib.addReporter(gulpOptions.reporters[i]);
        }
    }

    //// configure jasmine (pass back, rather than global vars?)
    configJasmine(gulpOptions.jasmineVersion);

    if(!!gulpOptions.integration) {
        //// integration test
        return through.obj(
            function (file, encoding, callback) {
                if (file.isNull()) {
                    callback(null, file);
                    return;
                }
                if (file.isStream()) {
                    callback(new gutil.PluginError(pluginName, 'Streaming not supported'));
                    return;
                }
                filePaths.push(file.path);
                callback(null, file);
            },
            //// through2 flush function (called just prior to the stream ending. Can be used to finish up any processing that may be in progress.)
            function (callback) {
                gutil.log('Running Jasmine with PhantomJS');
                try {
                    if(gulpOptions.specHtml) {
                        runPhantom(
                            [
                                jasmineRunner,
                                path.resolve(gulpOptions.specHtml),
                                JSON.stringify(gulpOptions)
                            ],
                            function(success) {
                                callback(success);
                            }
                        );
                    } else {
                        compileRunner({
                            files: filePaths,
                            onComplete: function(success) {
                                callback(success);
                            }
                        });
                    }
                } catch(error) {
                    callback(new gutil.PluginError(pluginName, error));
                }
            }
        );
    }
    //// unit test
    return through.obj(
        function(file, encoding, callback) {
            if (file.isNull()) {
                callback(null, file);
                return;
            }

            if (file.isStream()) {
                callback(new gutil.PluginError('gulp-jasmine-phantom', 'Streaming not supported'));
                return;
            }

            /**
            * Get the cache object of the specs.js file,
            * get its children and delete the childrens cache
            */
            var modId = require.resolve(path.resolve(file.path));
            var files = require.cache[modId];
            if (typeof files !== 'undefined') {
                for (var i in files.children) {
                    delete require.cache[files.children[i].id];
                }
            }
            delete require.cache[modId];

            miniJasmineLib.addSpecs(file.path);
            filePaths.push(file.path);
            callback(null, file);
        },
        //// through2 flush function (called just prior to the stream ending. Can be used to finish up any processing that may be in progress.)
        function(callback) {
            var stream = this;
            gutil.log('Running Jasmine with minijasminenode2');

            try {
                miniJasmineLib.executeSpecs({
                    reporter: terminalReporter,
                    showColors: true,
                    includeStackTrace: gulpOptions.includeStackTrace,
                    onComplete: function(passed) {
                        if(gulpOptions.keepRunner) {
                            try {
                                compileRunner({
                                    files: filePaths,
                                    onComplete: function() {
                                        callback(null);
                                    }
                                });
                            } catch(error) {
                                callback(new gutil.PluginError('gulp-jasmine-phantom', error));
                            }
                        } else {
                            callback(null);
                        }
                        //// if any specs fail return 1
                        if (!passed) {
                            process.exit(1);
                        }
                    }
                });
            } catch(error) {
                callback(new gutil.PluginError('gulp-jasmine-phantom', error));
            }
        }
    );
};
