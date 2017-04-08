'use babel'

// eslint-disable-next-line import/no-extraneous-dependencies, import/extensions
import { CompositeDisposable, Task } from 'atom'

// Dependencies
let path
let helpers
let workerHelpers
let isConfigAtHomeRoot

// Configuration
const scopes = []
let showRule
let ignoredRulesWhenModified
let ignoredRulesWhenFixing
let disableWhenNoEslintConfig

// Internal functions
const idsToIgnoredRules = ruleIds =>
  ruleIds.reduce((ids, id) => {
    ids[id] = 0 // 0 is the severity to turn off a rule
    return ids
  }, {})

module.exports = {
  activate() {
    const installLinterEslintDeps = () => require('atom-package-deps').install('linter-eslint')
    if (!atom.inSpecMode()) {
      window.requestIdleCallback(installLinterEslintDeps)
    }

    this.subscriptions = new CompositeDisposable()
    this.worker = null
    const initializeWorker = () => {
      this.worker = new Task(require.resolve('./worker.js'))
    }

    this.subscriptions.add(
      atom.config.observe('linter-eslint.scopes', (value) => {
        // Remove any old scopes
        scopes.splice(0, scopes.length)
        // Add the current scopes
        Array.prototype.push.apply(scopes, value)
      })
    )

    const embeddedScope = 'source.js.embedded.html'
    this.subscriptions.add(atom.config.observe('linter-eslint.lintHtmlFiles',
      (lintHtmlFiles) => {
        if (lintHtmlFiles) {
          scopes.push(embeddedScope)
        } else if (scopes.indexOf(embeddedScope) !== -1) {
          scopes.splice(scopes.indexOf(embeddedScope), 1)
        }
      })
    )

    this.subscriptions.add(atom.workspace.observeTextEditors((editor) => {
      editor.onDidSave(async () => {
        const validScope = editor.getCursors().some(cursor =>
          cursor.getScopeDescriptor().getScopesArray().some(scope =>
            scopes.includes(scope)))
        if (validScope && atom.config.get('linter-eslint.fixOnSave')) {
          await this.fixJob(true)
        }
      })
    }))

    this.subscriptions.add(atom.commands.add('atom-text-editor', {
      'linter-eslint:debug': async () => {
        if (!helpers) {
          helpers = require('./helpers')
        }
        const debugString = await helpers.generateDebugString(this.worker)
        const notificationOptions = { detail: debugString, dismissable: true }
        atom.notifications.addInfo('linter-eslint debugging information', notificationOptions)
      }
    }))

    this.subscriptions.add(atom.commands.add('atom-text-editor', {
      'linter-eslint:fix-file': async () => {
        await this.fixJob()
      }
    }))

    this.subscriptions.add(atom.config.observe('linter-eslint.showRuleIdInMessage',
      (value) => {
        showRule = value
      })
    )

    this.subscriptions.add(atom.config.observe('linter-eslint.disableWhenNoEslintConfig',
      (value) => {
        disableWhenNoEslintConfig = value
      })
    )

    this.subscriptions.add(atom.config.observe('linter-eslint.rulesToSilenceWhileTyping', (ids) => {
      ignoredRulesWhenModified = idsToIgnoredRules(ids)
    }))

    this.subscriptions.add(atom.config.observe('linter-eslint.rulesToDisableWhileFixing', (ids) => {
      ignoredRulesWhenFixing = idsToIgnoredRules(ids)
    }))

    // FIXME: Get this back to async
    // window.requestIdleCallback(initializeWorker)
    initializeWorker()
  },

  deactivate() {
    if (this.worker !== null) {
      console.log('terminating the worker')
      this.worker.terminate()
      this.worker = null
    }
    this.subscriptions.dispose()
  },

  provideLinter() {
    return {
      name: 'ESLint',
      grammarScopes: scopes,
      scope: 'file',
      lintOnFly: true,
      lint: async (textEditor) => {
        const filePath = textEditor.getPath()
        console.log('lint() on', filePath)

        const text = textEditor.getText()
        if (text.length === 0) {
          console.log('Empty editor')
          return []
        }
        // const filePath = textEditor.getPath()

        let rules = {}
        if (textEditor.isModified() && Object.keys(ignoredRulesWhenModified).length > 0) {
          rules = ignoredRulesWhenModified
        }

        if (!helpers) {
          helpers = require('./helpers')
        }

        let response
        try {
          response = await helpers.sendJob(this.worker, {
            type: 'lint',
            contents: text,
            config: atom.config.get('linter-eslint'),
            rules,
            filePath,
            projectPath: atom.project.relativizePath(filePath)[0] || ''
          })
        } catch (e) {
          throw e
        }

        if (textEditor.getText() !== text) {
          /*
             The editor text has been modified since the lint was triggered,
             as we can't be sure that the results will map properly back to
             the new contents, simply return `null` to tell the
             `provideLinter` consumer not to update the saved results.
           */
          return null
        }
        return helpers.processESLintMessages(response, textEditor, showRule, this.worker)
      }
    }
  },

  async fixJob(isSave = false) {
    const textEditor = atom.workspace.getActiveTextEditor()

    if (!textEditor || textEditor.isModified()) {
      // Abort for invalid or unsaved text editors
      const message = 'Linter-ESLint: Please save before fixing'
      atom.notifications.addError(message)
    }

    if (!path) {
      path = require('path')
    }
    if (!isConfigAtHomeRoot) {
      isConfigAtHomeRoot = require('./is-config-at-home-root')
    }
    if (!workerHelpers) {
      workerHelpers = require('./worker-helpers')
    }

    const filePath = textEditor.getPath()
    const fileDir = path.dirname(filePath)
    const projectPath = atom.project.relativizePath(filePath)[0]

    // Do not try to fix if linting should be disabled
    const configPath = workerHelpers.getConfigPath(fileDir)
    const noProjectConfig = (configPath === null || isConfigAtHomeRoot(configPath))
    if (noProjectConfig && disableWhenNoEslintConfig) {
      return
    }

    let rules = {}
    if (Object.keys(ignoredRulesWhenFixing).length > 0) {
      rules = ignoredRulesWhenFixing
    }

    // The fix replaces the file content and the cursor jumps automatically
    // to the beginning of the file, so save current cursor position
    const cursorPosition = textEditor.getCursorBufferPosition()
    if (!helpers) {
      helpers = require('./helpers')
    }
    try {
      const response = await helpers.sendJob(this.worker, {
        type: 'fix',
        config: atom.config.get('linter-eslint'),
        rules,
        filePath,
        projectPath
      })
      if (!isSave) {
        atom.notifications.addSuccess(response)
      }
      // set cursor to the position before fix job
      textEditor.setCursorBufferPosition(cursorPosition)
    } catch (err) {
      atom.notifications.addWarning(err.message)
    }
  },
}
