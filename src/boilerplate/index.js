const prompts = require('./prompts')
const { mergeDeepRight, pipe, assoc, omit, __ } = require('ramda')
const { getReactNativeVersion } = require('../lib/react-native-version')
const { replacePackageJsonVersions } = require('../lib/merge-package-json')
const { patchReactNativeNavigation } = require('../lib/react-native-navigation')
const Insight = require('../lib/insight')
const generateFiles = require('./files')
const rimraf = require('rimraf')
const importEntityJdl = require('../import-jdl/index')
const { importJDL } = require('../lib/import-jdl')
const fs = require('fs-extra')
const pkg = require('../../package')

/**
 * Is Android installed?
 *
 * $ANDROID_HOME/tools folder has to exist.
 *
 * @param {*} context - The gluegun context.
 * @returns {boolean}
 */
const isAndroidInstalled = function (context) {
  const androidHome = process.env['ANDROID_HOME']
  const hasAndroidEnv = !context.strings.isBlank(androidHome)
  const hasAndroid = hasAndroidEnv && context.filesystem.exists(`${androidHome}/tools`) === 'dir'

  return Boolean(hasAndroid)
}

/**
 * Let's install.
 *
 * @param {any} context - The gluegun context.
 */
async function install(context) {
  const { filesystem, parameters, ignite, reactNative, print, system, prompt, template } = context

  const perfStart = new Date().getTime()

  const name = parameters.first
  print.spin(`Using Ignite JHipster v${pkg.version}`).succeed()
  const spinner = print.spin(`Generating a React Native client for JHipster apps`).succeed()

  const props = {
    jhipsterDirectory: parameters.options['jh-dir'] || '',
    detox: parameters.options.detox,
    disableInsight: parameters.options['disable-insight'] || false,
  }
  let jhipsterConfig
  let jhipsterDirectory

  // if the user is passing in JDL
  if (parameters.options.jdl) {
    print.info('Importing JDL')
    const results = importJDL([`../${parameters.options.jdl}`], null, null, null, print)
    if (results.exportedApplications.length === 0) {
      print.error('No JHipster Applications found in the JDL file')
      process.exit(1)
    }
    if (results.exportedApplications.length > 1 || results.exportedDeployments.length > 0) {
      print.error('Multiple JHipster Applications or Deployments found in the JDL file, not supported for app generation')
      process.exit(1)
    }
    // remove the files generated by import-jdl
    await rimraf.sync('.yo-rc.json')
    await rimraf.sync('.jhipster')
    jhipsterConfig = results.exportedApplications[0]
    jhipsterDirectory = ''
    // if the user is passing in a directory
  } else if (props.jhipsterDirectory) {
    if (!fs.existsSync(`../${props.jhipsterDirectory}/.yo-rc.json`)) {
      print.error(`No JHipster configuration file found at ${props.jhipsterDirectory}/.yo-rc.json`)
      return
    }
    print.success(`Found the JHipster config at ${props.jhipsterDirectory}/.yo-rc.json`)
    const pathPrefix = props.jhipsterDirectory.startsWith('/') ? '' : '../'
    jhipsterConfig = await fs.readJson(`${pathPrefix}${props.jhipsterDirectory}/.yo-rc.json`)
    jhipsterDirectory = props.jhipsterDirectory
    // the user didn't pass in JDL or a path, prompt them for a path
  } else {
    // prompt the user until an JHipster configuration file is found
    while (true) {
      const jhipsterPathAnswer = await prompt.ask(prompts.jhipsterPath)
      // strip the trailing slash from the directory
      jhipsterDirectory = `${jhipsterPathAnswer.filePath}`.replace(/\/$/, ``)
      const jhipsterConfigPath = `${jhipsterDirectory}/.yo-rc.json`
      const pathPrefix = jhipsterDirectory.startsWith('/') ? '' : '../'
      print.info(`Looking for ${pathPrefix}${jhipsterConfigPath}`)
      if (fs.existsSync(`${pathPrefix}${jhipsterConfigPath}`)) {
        print.success(`Found JHipster config file at ${jhipsterConfigPath}`)
        jhipsterConfig = await fs.readJson(`${pathPrefix}${jhipsterConfigPath}`)
        break
      } else {
        print.error(`Could not find JHipster config file, please try again.`)
      }
    }
    props.jhipsterDirectory = jhipsterDirectory
  }

  if (!props.disableInsight && Insight.insight.optOut === undefined) {
    Insight.insight.optOut = !(await prompt.ask(prompts.insight)).insight
  }

  if (!props.detox && props.detox !== false) {
    const detoxPromptResponse = await prompt.ask(prompts.detox)
    props.detox = detoxPromptResponse.detox
  }

  props.skipGit = parameters.options['skip-git']
  props.skipCommitHook = parameters.options['skip-commit-hook']

  // is the npm flag present, or is yarn not available?
  const useNpm = Boolean(parameters.options.npm) || !system.which('yarn')
  print.info(`Using ${useNpm ? 'npm' : 'yarn'} as the package manager`)
  props.useNpm = useNpm

  props.disableInsight = Boolean(props.disableInsight)
  // very hacky but correctly handles both strings and booleans and converts to boolean
  // needed because it can be true or false, but if not provided it's prompted
  props.detox = JSON.parse(props.detox)

  // check for CocoaPods
  if (process.platform === 'darwin') {
    // if CocoaPods is installed, install the oauth dependencies
    const podVersionCommandResult = await system.spawn('pod --version', { stdio: 'ignore' })
    if (podVersionCommandResult.status !== 0) {
      print.error('CocoaPods is required for Ignite JHipster when generating on a Mac')
      print.info('Please see https://guides.cocoapods.org/using/getting-started.html')
      process.exit(1)
    }
  }

  // attempt to install React Native or die trying
  const rnInstall = await reactNative.install({
    name,
    version: getReactNativeVersion(context),
    useNpm: useNpm,
  })
  if (rnInstall.exitCode > 0) {
    print.error('Please try again with the --debug flag for a more verbose error')
    process.exit(rnInstall.exitCode)
  }

  // remove the __tests__ directory that come with React Native
  filesystem.remove('__tests__')
  filesystem.remove('App.js')

  props.name = name
  props.igniteVersion = ignite.version
  props.reactNativeVersion = rnInstall.version
  props.jhipsterDirectory = `../${props.jhipsterDirectory}`
  props.authType = jhipsterConfig['generator-jhipster'].authenticationType
  props.searchEngine = !!jhipsterConfig['generator-jhipster'].searchEngine
  props.websockets = !!jhipsterConfig['generator-jhipster'].websocket
  props.packageVersion = pkg.version
  await generateFiles(context, props, jhipsterConfig)

  /**
   * Merge the package.json from our template into the one provided from react-native init.
   */
  async function mergePackageJsons() {
    // transform our package.json, using raw JSON to replace versions, and add dependencies from the React Native template
    const rawJson = await template.generate({
      directory: `${ignite.ignitePluginPath()}/boilerplate`,
      template: 'package.json.ejs',
      props: props,
    })
    // replace version in the package.json.ejs template from the source file (package.json)
    let newPackageJson = JSON.parse(rawJson)
    newPackageJson = await replacePackageJsonVersions(context, newPackageJson, `${ignite.ignitePluginPath()}/boilerplate/package.json`)
    newPackageJson.devDependencies['ignite-jhipster'] = props.packageVersion

    // read in the react-native created package.json
    const currentPackage = filesystem.read('package.json', 'json')

    // deep merge
    const newPackage = pipe(
      assoc('dependencies', mergeDeepRight(currentPackage.dependencies, newPackageJson.dependencies)),
      assoc('devDependencies', mergeDeepRight(currentPackage.devDependencies, newPackageJson.devDependencies)),
      assoc('scripts', mergeDeepRight(currentPackage.scripts, newPackageJson.scripts)),
      mergeDeepRight(__, omit(['dependencies', 'devDependencies', 'scripts'], newPackageJson)),
    )(currentPackage)

    // write this out
    filesystem.write('package.json', newPackage, { jsonIndent: 2 })
  }
  await mergePackageJsons()
  spinner.stop()
  spinner.succeed(`project generated`)

  await patchReactNativeNavigation(context, props)

  if (!parameters.options.skipInstall) {
    spinner.text = `??? installing dependencies`
    spinner.start()
    // install any missing dependencies
    await system.run(useNpm ? 'npm i' : 'yarn', { stdio: 'ignore' })
    spinner.succeed(`dependencies installed`)
  }

  /**
   * Append to files
   */
  // https://github.com/facebook/react-native/issues/12724
  filesystem.appendAsync('.gitattributes', '*.bat text eol=crlf')
  filesystem.append('.gitignore', 'coverage/')
  filesystem.append('.gitignore', '\n# Misc\n#')
  filesystem.append('.gitignore', '.env\n')
  filesystem.append('.gitignore', 'ios/Index/DataStore\n')
  filesystem.append('.gitignore', 'ios/Carthage\n')
  filesystem.append('.gitignore', 'ios/Pods\n')
  filesystem.append('.gitignore', 'fastlane/report.xml\n')
  filesystem.append('.gitignore', 'android/app/bin\n')
  filesystem.append('.gitignore', '.artifacts\n')

  try {
    fs.mkdirSync(`.jhipster`)
    fs.writeJsonSync('.jhipster/yo-rc.json', jhipsterConfig, { spaces: '\t' })
    print.success(`JHipster config saved to your app's .jhipster folder.`)
  } catch (e) {
    print.error(e)
    throw e
  }

  // react native link -- must use spawn & stdio: ignore
  spinner.text = `??? linking native libraries`
  spinner.start()
  let showCocoapodsInstructions = false
  // if it's a mac
  if (process.platform === 'darwin' && !parameters.options.skipPodInstall) {
    // if cocoapods is installed, install the oauth dependencies
    const podVersionCommandResult = await system.spawn('pod --version', { stdio: 'ignore' })
    if (podVersionCommandResult.status === 0) {
      spinner.text = `??? running pod install`
      try {
        await system.run('cd ios && pod install && cd ..', { stdio: 'ignore' })
        spinner.succeed(`pod install succeeded`)
      } catch (e) {
        spinner.stopAndPersist({ symbol: '????', text: 'pod install failed, please try again manually:' })
        print.info(`cd ios && pod install && cd ..`)
        print.error(e)
      }
    } else {
      showCocoapodsInstructions = true
    }
  }
  spinner.succeed(`linked native libraries`)
  spinner.stop()

  // if JDL was passed to generate the app, generate any entities
  if (parameters.options.jdl) {
    await importEntityJdl.run(context)
  }

  // run prettier to pass lint on generation
  spinner.text = `??? running prettier on generated code`
  spinner.start()
  // install any missing dependencies
  await system.run(`${useNpm ? 'npm' : 'yarn'} run prettier`, { stdio: 'ignore' })

  const perfDuration = parseInt((new Date().getTime() - perfStart) / 10) / 100
  spinner.succeed(`ignited ${print.colors.yellow(name)} in ${perfDuration}s`)

  Insight.trackAppOptions(context, props)

  // Wrap it up with our success message.
  print.info('')
  print.info('???? Time to get cooking!')
  print.info('')
  if (props.websockets) {
    print.info('To enable the websockets example, see https://github.com/ruddell/ignite-jhipster/blob/main/docs/websockets.md')
    print.info('')
  }
  if (props.authType === 'oauth2') {
    print.info(print.colors.bold(`Before iOS apps can be run, there are steps that must be complete manually`))
    if (showCocoapodsInstructions) {
      print.info(print.colors.blue(`CocoaPods not found, please install CocooaPods and run 'pod install' from your app's ios directory.`))
    }
    print.info(
      'For more info on configuring OAuth2 OIDC Login, see https://github.com/ruddell/ignite-jhipster/blob/main/docs/oauth2-oidc.md',
    )
    print.info('')
  }
  print.info('To run in iOS:')
  print.info(print.colors.bold(`  cd ${name}`))
  print.info(print.colors.bold('  npx react-native run-ios'))
  print.info('')
  if (isAndroidInstalled(context)) {
    print.info('To run in Android:')
  } else {
    print.info(
      `To run in Android, make sure you've followed the latest react-native setup instructions at https://reactnative.dev/docs/environment-setup before using ignite.\nYou won't be able to run ${print.colors.bold(
        'npx react-native run-android',
      )} successfully until you have. Then:`,
    )
  }
  print.info(print.colors.bold(`  cd ${name}`))
  print.info(print.colors.bold('  npx react-native run-android'))
  print.info('')
  print.info('To see what JHipster generators are available:')
  print.info(print.colors.bold(`  cd ${name}`))
  print.info(print.colors.bold('  ignite generate'))
  print.info('')
  if (useNpm && context.parameters.options.boilerplate !== 'ignite-jhipster' && context.parameters.options.boilerplate !== 'jhipster') {
    print.warning(
      'NOTE: Using local ignite-jhipster, removing `.git` folder from `node_modules/ignite-jhipster` to prevent issues with `npm i`',
    )
    await rimraf.sync('../node_modules/ignite-jhipster/.git')
  }
}

module.exports = {
  install,
}
