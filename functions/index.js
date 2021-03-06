const functions = require('firebase-functions');
const admin = require('firebase-admin');
const moment = require('moment');

admin.initializeApp(functions.config().firestore);

// // Create and Deploy Your First Cloud Functions
// // https://firebase.google.com/docs/functions/write-firebase-functions
//
// exports.helloWorld = functions.https.onRequest((request, response) => {
//   functions.logger.info('Hello logs!', {structuredData: true});
//   response.send('Hello from Firebase!');
// });

exports.newTask = functions.firestore
    .document('tasks/{taskId}')
    .onCreate(async (snap, context) => {
        const newTask = snap.data();
        const userId = newTask.ministry.id;

        const userData = await admin
            .firestore()
            .collection('users')
            .doc(userId)
            .get();

        const user = userData.data();
        const tokens = user.tokens || [];

        let message = `[${newTask.minister.name}] No dia ${moment(newTask.date.toDate()).format('DD/MM/YY')} você tem`;

        if (newTask.functions && newTask.functions.length > 0) {
            message = `${message}${newTask.functions.length > 1 ? ' as funções' : ' a função'}: ${newTask.functions.join(', ')}`
        } else {
            message = `${message} um compromisso`
        }

        const notification = {
            notification: {
                title: 'Uma nova escala pra você!',
                body: message
            },
            data: {
                type: 'TASK',
                id: snap.id
            }
        }

        await sendNotification(tokens, notification, snap.id);
    });

exports.sendDailyNotifications = functions.pubsub
    .schedule('0 3 * * *') // 8 MORNING
    .onRun(async context => {
        let todayStart = moment()
        let todayEnd = moment()
        todayStart.startOf('day')
        todayEnd.endOf('day')

        functions.logger.info(`todayStart: ${todayStart} | todayEnd: ${todayEnd}`)

        const todayTasks = await admin.firestore()
            .collection('tasks')
            .where('date', '>=', todayStart.toDate())
            .where('date', '<=', todayEnd.toDate())
            .get()

        const docs = todayTasks.docs.map(d => ({ id: d.id, ...d.data() }))
        functions.logger.info(`docs: ${JSON.stringify(docs.map(d => d.id))}`)

        for await (const doc of docs) {
            let ministry = await admin.firestore()
                .collection('users')
                .doc(doc.ministry.id)
                .get()
            const tokens = ministry.data().tokens || []

            const notification = {
                notification: {
                    title: 'Não se esquece hein!',
                    body: `Hoje você está escalado(a) no(a) ${doc.minister.name}`
                },
                data: {
                    type: 'TASK',
                    id: doc.id
                }
            }

            await sendNotification(tokens, notification, doc.id)
        }
    })

exports.sendTomorrowNotifications = functions.pubsub
    .schedule('0 3 * * *') // 8 MORNING
    .onRun(async context => {
        let tomorrowStart = moment()
        let tomorrowEnd = moment()
        tomorrowStart.add(1, 'day')
        tomorrowEnd.add(1, 'day')
        tomorrowStart.startOf('day')
        tomorrowEnd.endOf('day')

        functions.logger.info(`todayStart: ${tomorrowStart} | todayEnd: ${tomorrowEnd}`)

        const todayTasks = await admin.firestore()
            .collection('tasks')
            .where('date', '>', tomorrowStart.toDate())
            .where('date', '<', tomorrowEnd.toDate())
            .get()

        for await (const doc of todayTasks.docs.map(d => ({ id: d.id, ...d.data() }))) {
            let ministry = await admin.firestore()
                .collection('users')
                .doc(doc.ministry.id)
                .get()
            const tokens = ministry.data().tokens || []

            const notification = {
                notification: {
                    title: 'Não se esquece hein!',
                    body: `Amanhã você está escalado(a) no(a) ${doc.minister.name}`
                },
                data: {
                    type: 'TASK',
                    id: doc.id
                }
            }

            await sendNotification(tokens, notification, doc.id)
        }
    })

exports.newChangeRequest = functions.firestore
    .document('change-requests/{changeRequestId}')
    .onCreate(async (snap, context) => {
        const newChangeRequest = snap.data();
        const ministerId = newChangeRequest.task.minister.id

        const notification = {
            notification: {
                title: `${newChangeRequest.task.ministry.name} está precisando de ajuda!`,
                body: `[${newChangeRequest.task.minister.name}] Precisa de troca no dia ${moment(newChangeRequest.task.date.toDate()).format('DD/MM/YY')}.`
            },
            data: {
                type: 'CHANGE_REQUEST',
            }
        }

        await sendMessageToPartners(ministerId, newChangeRequest, notification, snap.id)
    });

exports.deletingTask = functions.firestore
    .document('tasks/{taskId}')
    .onDelete(async (snap, context) => {
        const taskId = snap.id

        admin.firestore()
            .collection('change-requests')
            .where('task.id', '==', taskId)
            .get()
            .then(data => {
                data.docs.forEach(doc => {
                    admin.firestore()
                        .collection('change-requests')
                        .doc(doc.id)
                        .delete()
                })
            })
    })

exports.updateUser = functions.firestore
    .document('users/{userId}')
    .onUpdate(async (snap, context) => {
        const userId = context.params.userId
        functions.logger.info(`monitor user: ${userId}`)

        const ministersNotification = await checkAndNotifyNewMinister(snap)
        const ministersLeadNotification = await checkAndNotifyNewMinisterLead(snap)

        const user = await getUserById(userId)

        const tokens = user.tokens
        functions.logger.info(`send to tokens: ${tokens.toString()}`)

        ministersNotification && await sendNotification(tokens, ministersNotification, snap.id)
        ministersLeadNotification && await sendNotification(tokens, ministersLeadNotification, snap.id)
    })

exports.changeRequestNotify = functions.pubsub
    .schedule('0 3 * * *') // 8 MORNING
    .onRun(async context => {
        const pendingChangeRequests = await admin.firestore()
            .collection('change-requests')
            .where('task.date', '>=', admin.firestore.Timestamp.fromDate(moment().startOf('day').toDate()))
            .where('done', '!=', true)
            .get()

        const docs = pendingChangeRequests.docs
            .filter(d => !d.done)
            .map(d => ({ id: d.id, ...d.data() }))
        functions.logger.info(`pendingChangeRequests: ${JSON.stringify(docs.map(d => d.id))}`)

        for await (const doc of docs) {
            const notification = {
                notification: {
                    title: 'O(A) coleguinha está precisando de ajuda ainda!',
                    body: `[${doc.task.minister.name}] Precisa de troca no dia ${moment(doc.task.date.toDate()).format('DD/MM/YY')}.`
                },
                data: {
                    type: 'CHANGE_REQUEST',
                    id: doc.id
                }
            }

            await sendMessageToPartners(doc.task.minister.id, doc, notification, doc.id)
        }
    })

exports.updateChurchId = functions.https.onRequest((req, res) => {
    if (!req.query.churchId) {
        res.send({
            error: 'The \'churchId\' param is required!'
        })
        return
    }

    let objs = []

    admin
        .firestore()
        .collection('users')
        .get()
        .then(data => {
            data.forEach(d => {
                let obj = { ...d.data() }
                if (!obj.churchId || obj.churchId == null) {
                    obj.churchId = req.query.churchId
                }
                delete obj.churches

                objs.push(obj)

                admin
                    .firestore()
                    .collection('users')
                    .doc(d.id)
                    .set(obj)
                    .finally(() => functions.logger.info(`update churchId on user: ${obj.name}`))
            })
        })
        .finally(() => res.send(objs))

    return;
})

async function checkAndNotifyNewMinister(snap) {
    const newMinister = snap.after.data().ministers.find(minister => !snap.before.data().ministers.includes(minister));
    functions.logger.info(`new minister: ${newMinister}`);

    const minister = await getMinisterById(newMinister);

    const notification = {
        notification: {
            title: `Novo ministério`,
            body: `Você acaba de entrar no(a) ${minister.name}.`
        },
        data: {
            type: 'UPDATE_USER'
        }
    };
    return notification;
}

async function checkAndNotifyNewMinisterLead(snap) {
    const newMinister = (snap.after.data().ministersLead || []).find(minister => !(snap.before.data().ministersLead || []).includes(minister));
    functions.logger.info(`new ministersLead: ${newMinister}`);

    if (newMinister) {
        const minister = await getMinisterById(newMinister);

        if (minister) {

            const notification = {
                notification: {
                    title: `Novo ministério`,
                    body: `Você acaba de se tornar líder no(a) ${minister.name}.`
                },
                data: {
                    type: 'UPDATE_USER'
                }
            };
            return notification;
        } else {
            return undefined
        }
    }
}

async function getUserById(userId) {
    const user = await admin
        .firestore()
        .collection('users')
        .doc(userId)
        .get();

    return user.exists ? { id: user.id, ...user.data() } : undefined;
}

async function getMinisterById(newMinister) {
    const minister = await admin
        .firestore()
        .collection('ministers')
        .doc(newMinister)
        .get();

    return minister.exists ? { id: minister.id, ...minister.data() } : undefined
}

async function findAndDeleteTokenOnUser(canonicalRegistrationToken) {
  if (canonicalRegistrationToken) {
    const userData = await admin
      .firestore()
      .collection('users')
      .where('tokens', 'array-contains', canonicalRegistrationToken)
      .get();

    if (!userData.empty && userData.docs[0].exists) {
      const tokens = userData.docs[0].data().tokens.filter((token) => token != canonicalRegistrationToken);

      admin
        .firestore()
        .collection('users')
        .doc(userData.docs[0].id)
        .update({ tokens });
    }
  }
}

async function sendNotification(tokens, notification, taskId) {
    functions.logger.info(`send notification: ${JSON.stringify({ tokens, notification, taskId })}`)

    const notificationResult = await admin
        .messaging()
        .sendToDevice(tokens, notification);

    notificationResult.results.forEach(r => {
        if (r.error) {
            functions.logger.error(`An ocurred error. taskId: ${taskId}`, { ...r.error.message, token: r.canonicalRegistrationToken });

            if (r.error.message.includes('The provided registration token is not registered')) {
                functions.logger.error(`Token unregisterd`, r.error.stack)
                findAndDeleteTokenOnUser(r.canonicalRegistrationToken)
            }
        }
    });
}

async function sendMessageToPartners(ministerId, changeRequest, notification, snapId) {
    const ministerData = await admin
        .firestore()
        .collection('ministers')
        .doc(ministerId)
        .get()

    functions.logger.info(`check users from ministerId: ${ministerId}`)

    let targetField = (ministerData.data().changesFree || ministerData.data().changesFree == undefined) ? 'ministers' : 'ministersLead'
    const usersData = await admin
        .firestore()
        .collection('users')
        .where(targetField, 'array-contains', ministerId)
        .get()

    if (!usersData) return

    const usersFound = usersData.docs
        .filter(d => d.id != changeRequest.task.ministry.id)
        .map(d => d.data())
    functions.logger.info(`users found: ${JSON.stringify(usersFound.map(user => user.id))}`)

    let tokens = usersFound.map(d => d.tokens) || []
    tokens = tokens.flat(2)

    await sendNotification(tokens, notification, snapId)
}