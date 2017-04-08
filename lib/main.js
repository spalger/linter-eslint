'use strict';
'use babel';

// eslint-disable-next-line import/no-extraneous-dependencies, import/extensions

var _atom = require('atom');

function _asyncToGenerator(fn) { return function () { var gen = fn.apply(this, arguments); return new Promise(function (resolve, reject) { function step(key, arg) { try { var info = gen[key](arg); var value = info.value; } catch (error) { reject(error); return; } if (info.done) { resolve(value); } else { return Promise.resolve(value).then(function (value) { step("next", value); }, function (err) { step("throw", err); }); } } return step("next"); }); }; }

// Dependencies
let path;
let helpers;
let workerHelpers;
let isConfigAtHomeRoot;

// Configuration
const scopes = [];
let showRule;
let ignoredRulesWhenModified;
let ignoredRulesWhenFixing;
let disableWhenNoEslintConfig;

// Internal functions
const idsToIgnoredRules = ruleIds => ruleIds.reduce((ids, id) => {
  ids[id] = 0; // 0 is the severity to turn off a rule
  return ids;
}, {});

module.exports = {
  activate() {
    var _this = this;

    const installLinterEslintDeps = () => require('atom-package-deps').install('linter-eslint');
    if (!atom.inSpecMode()) {
      window.requestIdleCallback(installLinterEslintDeps);
    }

    this.subscriptions = new _atom.CompositeDisposable();
    this.worker = null;
    const initializeWorker = () => {
      this.worker = new _atom.Task(require.resolve('./worker.js'));
    };

    this.subscriptions.add(atom.config.observe('linter-eslint.scopes', value => {
      // Remove any old scopes
      scopes.splice(0, scopes.length);
      // Add the current scopes
      Array.prototype.push.apply(scopes, value);
    }));

    const embeddedScope = 'source.js.embedded.html';
    this.subscriptions.add(atom.config.observe('linter-eslint.lintHtmlFiles', lintHtmlFiles => {
      if (lintHtmlFiles) {
        scopes.push(embeddedScope);
      } else if (scopes.indexOf(embeddedScope) !== -1) {
        scopes.splice(scopes.indexOf(embeddedScope), 1);
      }
    }));

    this.subscriptions.add(atom.workspace.observeTextEditors(editor => {
      editor.onDidSave(_asyncToGenerator(function* () {
        const validScope = editor.getCursors().some(function (cursor) {
          return cursor.getScopeDescriptor().getScopesArray().some(function (scope) {
            return scopes.includes(scope);
          });
        });
        if (validScope && atom.config.get('linter-eslint.fixOnSave')) {
          yield _this.fixJob(true);
        }
      }));
    }));

    this.subscriptions.add(atom.commands.add('atom-text-editor', {
      'linter-eslint:debug': (() => {
        var _ref2 = _asyncToGenerator(function* () {
          if (!helpers) {
            helpers = require('./helpers');
          }
          const debugString = yield helpers.generateDebugString(_this.worker);
          const notificationOptions = { detail: debugString, dismissable: true };
          atom.notifications.addInfo('linter-eslint debugging information', notificationOptions);
        });

        return function linterEslintDebug() {
          return _ref2.apply(this, arguments);
        };
      })()
    }));

    this.subscriptions.add(atom.commands.add('atom-text-editor', {
      'linter-eslint:fix-file': (() => {
        var _ref3 = _asyncToGenerator(function* () {
          yield _this.fixJob();
        });

        return function linterEslintFixFile() {
          return _ref3.apply(this, arguments);
        };
      })()
    }));

    this.subscriptions.add(atom.config.observe('linter-eslint.showRuleIdInMessage', value => {
      showRule = value;
    }));

    this.subscriptions.add(atom.config.observe('linter-eslint.disableWhenNoEslintConfig', value => {
      disableWhenNoEslintConfig = value;
    }));

    this.subscriptions.add(atom.config.observe('linter-eslint.rulesToSilenceWhileTyping', ids => {
      ignoredRulesWhenModified = idsToIgnoredRules(ids);
    }));

    this.subscriptions.add(atom.config.observe('linter-eslint.rulesToDisableWhileFixing', ids => {
      ignoredRulesWhenFixing = idsToIgnoredRules(ids);
    }));

    // FIXME: Get this back to async
    // window.requestIdleCallback(initializeWorker)
    initializeWorker();
  },

  deactivate() {
    if (this.worker !== null) {
      console.log('terminating the worker');
      this.worker.terminate();
      this.worker = null;
    }
    this.subscriptions.dispose();
  },

  provideLinter() {
    var _this2 = this;

    return {
      name: 'ESLint',
      grammarScopes: scopes,
      scope: 'file',
      lintOnFly: true,
      lint: (() => {
        var _ref4 = _asyncToGenerator(function* (textEditor) {
          const filePath = textEditor.getPath();
          console.log('lint() on', filePath);

          const text = textEditor.getText();
          if (text.length === 0) {
            console.log('Empty editor');
            return [];
          }
          // const filePath = textEditor.getPath()

          let rules = {};
          if (textEditor.isModified() && Object.keys(ignoredRulesWhenModified).length > 0) {
            rules = ignoredRulesWhenModified;
          }

          if (!helpers) {
            helpers = require('./helpers');
          }

          let response;
          try {
            response = yield helpers.sendJob(_this2.worker, {
              type: 'lint',
              contents: text,
              config: atom.config.get('linter-eslint'),
              rules,
              filePath,
              projectPath: atom.project.relativizePath(filePath)[0] || ''
            });
          } catch (e) {
            throw e;
          }

          if (textEditor.getText() !== text) {
            /*
               The editor text has been modified since the lint was triggered,
               as we can't be sure that the results will map properly back to
               the new contents, simply return `null` to tell the
               `provideLinter` consumer not to update the saved results.
             */
            return null;
          }
          return helpers.processESLintMessages(response, textEditor, showRule, _this2.worker);
        });

        return function lint(_x) {
          return _ref4.apply(this, arguments);
        };
      })()
    };
  },

  fixJob() {
    var _arguments = arguments,
        _this3 = this;

    return _asyncToGenerator(function* () {
      let isSave = _arguments.length > 0 && _arguments[0] !== undefined ? _arguments[0] : false;

      const textEditor = atom.workspace.getActiveTextEditor();

      if (!textEditor || textEditor.isModified()) {
        // Abort for invalid or unsaved text editors
        const message = 'Linter-ESLint: Please save before fixing';
        atom.notifications.addError(message);
      }

      if (!path) {
        path = require('path');
      }
      if (!isConfigAtHomeRoot) {
        isConfigAtHomeRoot = require('./is-config-at-home-root');
      }
      if (!workerHelpers) {
        workerHelpers = require('./worker-helpers');
      }

      const filePath = textEditor.getPath();
      const fileDir = path.dirname(filePath);
      const projectPath = atom.project.relativizePath(filePath)[0];

      // Do not try to fix if linting should be disabled
      const configPath = workerHelpers.getConfigPath(fileDir);
      const noProjectConfig = configPath === null || isConfigAtHomeRoot(configPath);
      if (noProjectConfig && disableWhenNoEslintConfig) {
        return;
      }

      let rules = {};
      if (Object.keys(ignoredRulesWhenFixing).length > 0) {
        rules = ignoredRulesWhenFixing;
      }

      // The fix replaces the file content and the cursor jumps automatically
      // to the beginning of the file, so save current cursor position
      const cursorPosition = textEditor.getCursorBufferPosition();
      if (!helpers) {
        helpers = require('./helpers');
      }
      try {
        const response = yield helpers.sendJob(_this3.worker, {
          type: 'fix',
          config: atom.config.get('linter-eslint'),
          rules,
          filePath,
          projectPath
        });
        if (!isSave) {
          atom.notifications.addSuccess(response);
        }
        // set cursor to the position before fix job
        textEditor.setCursorBufferPosition(cursorPosition);
      } catch (err) {
        atom.notifications.addWarning(err.message);
      }
    })();
  }
};