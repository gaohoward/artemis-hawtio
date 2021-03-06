/**
 * @module ARTEMIS
 */
var ARTEMIS = (function(ARTEMIS) {
   ARTEMIS.BrokerDiagramController = function ($scope, $compile, $location, localStorage, ARTEMISService, jolokia, workspace, $routeParams) {

      Fabric.initScope($scope, $location, jolokia, workspace);
      var artemisJmxDomain = localStorage['artemisJmxDomain'] || "org.apache.activemq.artemis";
      var isFmc = Fabric.isFMCContainer(workspace);
      $scope.isFmc = isFmc;
      if (isFmc) {
         $scope.version = $routeParams['versionId'];
         if ($scope.version == 'default-version') {
            $scope.version = Fabric.getDefaultVersionId(jolokia);
         }
         $scope.selectedVersion = {id: $scope.version};
      }
      $scope.selectedNode = null;
      var defaultFlags = {
         panel: true,
         popup: false,
         label: true,
         group: false,
         profile: false,
         slave: false,
         broker: true,
         network: true,
         container: false,
         queue: true,
         topic: true,
         allQueue: false,
         allTopic: false,
         consumer: true,
         producer: true
      };
      $scope.viewSettings = {};
      $scope.shapeSize = {
         broker: 20,
         queue: 14,
         topic: 14
      };
      var redrawGraph = Core.throttled(doRedrawGraph, 1000);
      var graphBuilder = new ForceGraph.GraphBuilder();
      Core.bindModelToSearchParam($scope, $location, "searchFilter", "q", "");
      angular.forEach(defaultFlags, function (defaultValue, key) {
         var modelName = "viewSettings." + key;
         // bind model values to search params...
         function currentValue() {
            var answer = $location.search()[paramName] || defaultValue;
            return answer === "false" ? false : answer;
         }

         var paramName = key;
         var value = currentValue();
         Core.pathSet($scope, modelName, value);
         $scope.$watch(modelName, function () {
            var current = Core.pathGet($scope, modelName);
            var old = currentValue();
            if (current !== old) {
               var defaultValue = defaultFlags[key];
               if (current !== defaultValue) {
                  if (!current) {
                     current = "false";
                  }
                  $location.search(paramName, current);
               }
               else {
                  $location.search(paramName, null);
               }
            }
            redrawGraph();
         });
      });
      $scope.connectToBroker = function () {
         var selectedNode = $scope.selectedNode;
         if (selectedNode) {
            var container = selectedNode["brokerContainer"] || selectedNode;
            connectToBroker(container, selectedNode["brokerName"]);
         }
      };
      function connectToBroker(container, brokerName, postfix) {
         if (postfix === void 0) {
            postfix = null;
         }
         if (isFmc && container.jolokia !== jolokia) {
            Fabric.connectToBroker($scope, container, postfix);
         }
         else {
            var view = "/jmx/attributes?tab=artemis";
            if (!postfix) {
               if (brokerName) {
                  // lets default to the broker view
                  postfix = "nid=root-" + artemisJmxDomain + "-Broker-" + brokerName;
               }
            }
            if (postfix) {
               view += "&" + postfix;
            }
            var path = Core.url("/#" + view);
            window.open(path, '_destination');
            window.focus();
         }
      }

      $scope.connectToDestination = function () {
         var selectedNode = $scope.selectedNode;
         if (selectedNode) {
            var container = selectedNode["brokerContainer"] || selectedNode;
            var brokerName = selectedNode["brokerName"];
            var destinationType = selectedNode["destinationType"] || selectedNode["typeLabel"];
            var destinationName = selectedNode["destinationName"];
            var postfix = null;
            if (brokerName && destinationType && destinationName) {
               postfix = "nid=root-" + artemisJmxDomain + "-Broker-" + brokerName + "-" + destinationType + "-" + destinationName;
            }
            connectToBroker(container, brokerName, postfix);
         }
      };
      $scope.$on('$destroy', function (event) {
         stopOldJolokia();
      });
      function stopOldJolokia() {
         var oldJolokia = $scope.selectedNodeJolokia;
         if (oldJolokia && oldJolokia !== jolokia) {
            oldJolokia.stop();
         }
      }

      $scope.$watch("selectedNode", function (newValue, oldValue) {
         // lets cancel any previously registered thingy
         if ($scope.unregisterFn) {
            $scope.unregisterFn();
            $scope.unregisterFn = null;
         }
         var node = $scope.selectedNode;
         if (node) {
            var mbean = node.objectName;
            var brokerContainer = node.brokerContainer || {};
            var nodeJolokia = node.jolokia || brokerContainer.jolokia || jolokia;
            if (nodeJolokia !== $scope.selectedNodeJolokia) {
               stopOldJolokia();
               $scope.selectedNodeJolokia = nodeJolokia;
               if (nodeJolokia !== jolokia) {
                  var rate = Core.parseIntValue(localStorage['updateRate'] || "2000", "update rate");
                  if (rate) {
                     nodeJolokia.start(rate);
                  }
               }
            }
            var dummyResponse = {value: node.panelProperties || {}};
            if (mbean && nodeJolokia) {
               ARTEMIS.log.debug("reading ", mbean, " on remote container");
               $scope.unregisterFn = Core.register(nodeJolokia, $scope, {
                  type: 'read',
                  mbean: mbean
               }, onSuccess(renderNodeAttributes, {
                  error: function (response) {
                     // probably we've got a wrong mbean name?
                     // so lets render at least
                     renderNodeAttributes(dummyResponse);
                     Core.defaultJolokiaErrorHandler(response);
                  }
               }));
            }
            else {
               ARTEMIS.log.debug("no mbean or jolokia available, using dummy response");
               renderNodeAttributes(dummyResponse);
            }
         }
      });
      function getDestinationTypeName(attributes) {
         var prefix = attributes["DestinationTemporary"] ? "Temporary " : "";
         return prefix + (attributes["DestinationTopic"] ? "Topic" : "Queue");
      }

      var ignoreNodeAttributes = ["Broker", "BrokerId", "BrokerName", "Connection", "DestinationName", "DestinationQueue", "DestinationTemporary", "DestinationTopic",];
      var ignoreNodeAttributesByType = {
         producer: ["Producer", "ProducerId"],
         queue: ["Name", "MessageGroups", "MessageGroupType", "Subscriptions"],
         topic: ["Name", "Subscriptions"],
         broker: ["DataDirectory", "DurableTopicSubscriptions", "DynamicDestinationProducers", "InactiveDurableToppicSubscribers"]
      };
      var brokerShowProperties = ["Version", "Started"];
      var onlyShowAttributesByType = {
         broker: brokerShowProperties,
         brokerSlave: brokerShowProperties
      };

      function renderNodeAttributes(response) {
         var properties = [];
         if (response) {
            var value = response.value || {};
            $scope.selectedNodeAttributes = value;
            var selectedNode = $scope.selectedNode || {};
            var brokerContainer = selectedNode['brokerContainer'] || {};
            var nodeType = selectedNode["type"];
            var brokerName = selectedNode["brokerName"];
            var containerId = selectedNode["container"] || brokerContainer["container"];
            var group = selectedNode["group"] || brokerContainer["group"];
            var jolokiaUrl = selectedNode["jolokiaUrl"] || brokerContainer["jolokiaUrl"];
            var profile = selectedNode["profile"] || brokerContainer["profile"];
            var version = selectedNode["version"] || brokerContainer["version"];
            var isBroker = nodeType && nodeType.startsWith("broker");
            var ignoreKeys = ignoreNodeAttributes.concat(ignoreNodeAttributesByType[nodeType] || []);
            var onlyShowKeys = onlyShowAttributesByType[nodeType];
            angular.forEach(value, function (v, k) {
               if (onlyShowKeys ? onlyShowKeys.indexOf(k) >= 0 : ignoreKeys.indexOf(k) < 0) {
                  var formattedValue = Core.humanizeValueHtml(v);
                  properties.push({key: Core.humanizeValue(k), value: formattedValue});
               }
            });
            properties = properties.sortBy("key");
            var brokerProperty = null;
            if (brokerName) {
               var brokerHtml = '<a target="broker" ng-click="connectToBroker()">' + '<img title="Apache Artemis" src="img/icons/messagebroker.svg"> ' + brokerName + '</a>';
               if (version && profile) {
                  var brokerLink = Fabric.brokerConfigLink(workspace, jolokia, localStorage, version, profile, brokerName);
                  if (brokerLink) {
                     brokerHtml += ' <a title="configuration settings" target="brokerConfig" href="' + brokerLink + '"><i class="icon-tasks"></i></a>';
                  }
               }
               var html = $compile(brokerHtml)($scope);
               brokerProperty = {key: "Broker", value: html};
               if (!isBroker) {
                  properties.splice(0, 0, brokerProperty);
               }
            }
            if (containerId) {
               //var containerModel = "selectedNode" + (selectedNode['brokerContainer'] ? ".brokerContainer" : "");
               properties.splice(0, 0, {
                  key: "Container",
                  value: $compile('<div fabric-container-link="' + selectedNode['container'] + '"></div>')($scope)
               });
            }
            var destinationName = value["DestinationName"] || selectedNode["destinationName"];
            if (destinationName && (nodeType !== "queue" && nodeType !== "topic")) {
               var destinationTypeName = getDestinationTypeName(value);
               var html = createDestinationLink(destinationName, destinationTypeName);
               properties.splice(0, 0, {key: destinationTypeName, value: html});
            }
            var typeLabel = selectedNode["typeLabel"];
            var name = selectedNode["name"] || selectedNode["id"] || selectedNode['objectName'];
            if (typeLabel) {
               var html = name;
               if (nodeType === "queue" || nodeType === "topic") {
                  html = createDestinationLink(name, nodeType);
               }
               var typeProperty = {key: typeLabel, value: html};
               if (isBroker && brokerProperty) {
                  typeProperty = brokerProperty;
               }
               properties.splice(0, 0, typeProperty);
            }
         }
         $scope.selectedNodeProperties = properties;
         Core.$apply($scope);
      }

      /**
       * Generates the HTML for a link to the destination
       */
      function createDestinationLink(destinationName, destinationType) {
         if (destinationType === void 0) {
            destinationType = "queue";
         }
         return $compile('<a target="destination" title="' + destinationName + '" ng-click="connectToDestination()">' + destinationName + '</a>')($scope);
      }

      $scope.$watch("searchFilter", function (newValue, oldValue) {
         redrawGraph();
      });
      if (isFmc) {
         var unreg = null;
         $scope.$watch('selectedVersion.id', function (newValue, oldValue) {
            if (!Core.isBlank(newValue)) {
               if (unreg) {
                  unreg();
               }
               unreg = Core.register(jolokia, $scope, {
                  type: 'exec',
                  mbean: Fabric.mqManagerMBean,
                  operation: "loadBrokerStatus(java.lang.String)",
                  arguments: [newValue]
               }, onSuccess(onBrokerData));
            }
         });
      }
      else {
         // lets just use the current stuff from the workspace
         $scope.$watch('workspace.tree', function () {
            redrawGraph();
         });
         $scope.$on('jmxTreeUpdated', function () {
            redrawGraph();
         });
      }
      function onBrokerData(response) {
         if (response) {
            var responseJson = angular.toJson(response.value);
            if ($scope.responseJson === responseJson) {
               return;
            }
            $scope.responseJson = responseJson;
            $scope.brokers = response.value;
            doRedrawGraph();
         }
      }

      function redrawFabricBrokers() {
         var containersToDelete = $scope.activeContainers || {};
         $scope.activeContainers = {};
         angular.forEach($scope.brokers, function (brokerStatus) {
            // only query master brokers which are provisioned correctly
            brokerStatus.validContainer = brokerStatus.alive && brokerStatus.master && brokerStatus.provisionStatus === "success";
            // don't use type field so we can use it for the node types..
            renameTypeProperty(brokerStatus);
            //log.info("Broker status: " + angular.toJson(brokerStatus, true));
            var groupId = brokerStatus.group;
            var profileId = brokerStatus.profile;
            var brokerId = brokerStatus.brokerName;
            var containerId = brokerStatus.container;
            var versionId = brokerStatus.version || "1.0";
            var group = getOrAddNode("group", groupId, brokerStatus, function () {
               return {
                  /*
                   navUrl: ,
                   image: {
                   url: "/hawtio/img/icons/osgi/bundle.png",
                   width: 32,
                   height:32
                   },
                   */
                  typeLabel: "Broker Group",
                  popup: {
                     title: "Broker Group: " + groupId,
                     content: "<p>" + groupId + "</p>"
                  }
               };
            });
            var profile = getOrAddNode("profile", profileId, brokerStatus, function () {
               return {
                  typeLabel: "Profile",
                  popup: {
                     title: "Profile: " + profileId,
                     content: "<p>" + profileId + "</p>"
                  }
               };
            });
            // TODO do we need to create a physical broker node per container and logical broker maybe?
            var container = null;
            if (containerId) {
               container = getOrAddNode("container", containerId, brokerStatus, function () {
                  return {
                     containerId: containerId,
                     typeLabel: "Container",
                     popup: {
                        title: "Container: " + containerId,
                        content: "<p>" + containerId + " version: " + versionId + "</p>"
                     }
                  };
               });
            }
            var master = brokerStatus.master;
            var broker = getOrAddBroker(master, brokerId, groupId, containerId, container, brokerStatus);
            if (container && container.validContainer) {
               var key = container.containerId;
               $scope.activeContainers[key] = container;
               delete containersToDelete[key];
            }
            // add the links...
            if ($scope.viewSettings.group) {
               if ($scope.viewSettings.profile) {
                  addLink(group, profile, "group");
                  addLink(profile, broker, "broker");
               }
               else {
                  addLink(group, broker, "group");
               }
            }
            else {
               if ($scope.viewSettings.profile) {
                  addLink(profile, broker, "broker");
               }
            }
            if (container) {
               if ((master || $scope.viewSettings.slave) && $scope.viewSettings.container) {
                  addLink(broker, container, "container");
                  container.destinationLinkNode = container;
               }
               else {
                  container.destinationLinkNode = broker;
               }
            }
         });
         redrawActiveContainers();
      }

      function redrawLocalBroker() {
         var container = {
            jolokia: jolokia
         };
         var containerId = "local";
         $scope.activeContainers = {
            containerId: container
         };
         var brokers = [];
         jolokia.search(artemisJmxDomain + ":type=Broker,brokerName=*,module=JMS,serviceType=Server", onSuccess(function (response) {
            angular.forEach(response, function (objectName) {
               var atts = ARTEMISService.artemisConsole.getServerAttributes(jolokia, objectName);
               var val = atts.value;
               var details = Core.parseMBean(objectName);
               if (details) {
                  var properties = details['attributes'];
                  ARTEMIS.log.info("Got broker: " + objectName + " on container: " + containerId + " properties: " + angular.toJson(properties, true));
                  if (properties) {
                     var master = true;
                     var brokerId = properties["brokerName"] || "unknown";
                     var nodeId = val["NodeID"];
                     var theBroker = {
                        brokerId: brokerId,
                        nodeId: nodeId
                     };
                     brokers.push(theBroker);
                     if ($scope.viewSettings.broker) {
                        var broker = getOrAddBroker(master, brokerId, nodeId, containerId, container, properties);
                     }
                  }
               }
            });

            redrawActiveContainers(brokers);
         }));
      }

      function redrawActiveContainers(brokers) {
         // TODO delete any nodes from dead containers in containersToDelete
         angular.forEach($scope.activeContainers, function (container, id) {
            var containerJolokia = container.jolokia;
            if (containerJolokia) {
               onContainerJolokia(containerJolokia, container, id, brokers);
            }
            else {
               Fabric.containerJolokia(jolokia, id, function (containerJolokia) {
                  return onContainerJolokia(containerJolokia, container, id, brokers);
               });
            }
         });
         $scope.graph = graphBuilder.buildGraph();
         Core.$apply($scope);
      }

      function doRedrawGraph() {
         graphBuilder = new ForceGraph.GraphBuilder();
         if (isFmc) {
            redrawFabricBrokers();
         }
         else {
            redrawLocalBroker();
         }
      }

      function brokerNameMarkup(brokerName) {
         return brokerName ? "<p></p>broker: " + brokerName + "</p>" : "";
      }

      function matchesDestinationName(destinationName, typeName) {
         if (destinationName) {
            var selection = workspace.selection;
            if (selection && selection.domain === artemisJmxDomain) {
               var type = selection.entries["destinationType"];
               if (type) {
                  if ((type === "Queue" && typeName === "topic") || (type === "Topic" && typeName === "queue")) {
                     return false;
                  }
               }
               var destName = selection.entries["destinationName"];
               if (destName) {
                  if (destName !== destinationName)
                     return false;
               }
            }
            // TODO if the current selection is a destination...
            return !$scope.searchFilter || destinationName.indexOf($scope.searchFilter) >= 0;
         }
         return false;
      }

      function onContainerJolokia(containerJolokia, container, id, brokers) {
         if (containerJolokia) {
            container.jolokia = containerJolokia;
            function getOrAddDestination(properties, typeName, destinationName, brokerName) {
               /*if (!matchesDestinationName(destinationName, typeName)) {
                  return null;
               }*/
               // should we be filtering this destination out
               /*var hideFlag = "topic" === typeName ? $scope.viewSettings.topic : $scope.viewSettings.queue;
               if (!hideFlag) {
                  return null;
               }*/
               var destination = getOrAddNode(typeName.toLowerCase(), destinationName, properties, function () {
                  var objectName = "";
                  if (brokerName) {
                     objectName = artemisJmxDomain + ":type=Broker,brokerName=" + brokerName + ",module=JMS,serviceType=" + typeName + ",name=" + destinationName;
                  }
                  var answer = {
                     typeLabel: typeName,
                     brokerContainer: container,
                     objectName: objectName,
                     jolokia: containerJolokia,
                     popup: {
                        title: typeName + ": " + destinationName,
                        content: brokerNameMarkup(brokerName)
                     }
                  };
                  if (!brokerName) {
                     containerJolokia.search(artemisJmxDomain + ":destinationType=" + typeName + ",destinationName=" + destinationName + ",*", onSuccess(function (response) {
                        if (response && response.length) {
                           answer.objectName = response[0];
                        }
                     }));
                  }
                  return answer;
               });
               if (destination && $scope.viewSettings.broker && brokerName) {
                  addLinkIds(brokerNodeId(brokerName), destination["id"], "destination");
               }
               return destination;
            }

            // find JMS queues
            if ($scope.viewSettings.allQueue) {
               containerJolokia.search(artemisJmxDomain + ":type=Broker,*,module=JMS,serviceType=Queue", onSuccess(function (response) {
               angular.forEach(response, function (objectName) {
                  var details = Core.parseMBean(objectName);
                  if (details) {
                     var properties = details['attributes'];
                     if (properties) {
                        configureDestinationProperties(properties);
                        var brokerName = properties.brokerName;
                        var typeName = properties.serviceType || properties.destinationType;
                        var destinationName = properties.name;
                        var destination = getOrAddDestination(properties, typeName, destinationName, brokerName);
                     }
                  }
               });
               graphModelUpdated();
            }));
            }

            // find JMS Topics
            if ($scope.viewSettings.allTopic) {
               containerJolokia.search(artemisJmxDomain + ":type=Broker,*,module=JMS,serviceType=Topic", onSuccess(function (response) {
               angular.forEach(response, function (objectName) {
                  var details = Core.parseMBean(objectName);
                  if (details) {
                     var properties = details['attributes'];
                     if (properties) {
                        configureDestinationProperties(properties);
                        var brokerName = properties.brokerName;
                        var typeName = properties.serviceType || properties.destinationType;
                        var destinationName = properties.name;
                        var destination = getOrAddDestination(properties, typeName, destinationName, brokerName);
                     }
                  }
               });
               graphModelUpdated();
               }));
            }

            angular.forEach(brokers, function (broker) {
               mBean = artemisJmxDomain + ":type=Broker,brokerName=" + broker.brokerId + ",module=JMS,serviceType=Server";
               // find consumers
               if ($scope.viewSettings.consumer) {
                  ARTEMISService.artemisConsole.getConsumers(mBean, containerJolokia, onSuccess(function (properties) {
                     consumers = properties.value;
                     //\"durable\":false,\"queueName\":\"jms.queue.TEST\",\"creationTime\":1453725131250,\"consumerID\":0,\"browseOnly\":false,\"destinationName\":\"TEST\",\"connectionID\":\"1002661336\",\"destinationType\":\"queue\",\"sessionID\":\"a7fb1e89-c35f-11e5-b064-54ee7531eccb\"
                     angular.forEach(angular.fromJson(consumers), function (consumer) {
                        if (consumer) {

                           configureDestinationProperties(consumer);
                           var consumerId = consumer.sessionID + "-" + consumer.consumerID;
                           if (consumerId) {
                              var destinationName = consumer.destinationName;
                              var typeName;
                              if (consumer.queueName) {
                                 typeName = "Queue";
                              }
                              else {
                                 typeName = "Topic"
                              }
                              var destination = getOrAddDestination(consumer, typeName, "\"" + destinationName + "\"", broker.brokerId);
                              if (destination) {
                                 addLink(container.destinationLinkNode, destination, "destination");
                                 var consumerNode = getOrAddNode("consumer", consumerId, consumer, function () {
                                    return {
                                       typeLabel: "Consumer",
                                       brokerContainer: container,
                                       //objectName: "null",
                                       jolokia: containerJolokia,
                                       popup: {
                                          title: "Consumer: " + consumerId,
                                          content: "<p>client: " + (consumer.connectionID || "") + "</p> " + brokerNameMarkup(broker.brokerId)
                                       }
                                    };
                                 });
                                 addLink(destination, consumerNode, "consumer");
                              }
                           }
                        }
                     });
                     graphModelUpdated();
                  }));
               }


               // find networks of brokers
               if ($scope.viewSettings.network && $scope.viewSettings.broker) {

                  ARTEMISService.artemisConsole.getRemoteBrokers(mBean, containerJolokia, onSuccess(function (properties) {
                     remoteBrokers = properties.value;
                     angular.forEach(angular.fromJson(remoteBrokers), function (remoteBroker) {
                        if (remoteBroker) {
                           if (broker.nodeId != remoteBroker.nodeID) {
                              getOrAddBroker(true, "\"" + remoteBroker.live + "\"", remoteBroker.nodeID, "remote", null, properties);
                              addLinkIds("broker:" + broker.brokerId, "broker:" + "\"" + remoteBroker.live + "\"", "network");

                              var backup = remoteBroker.backup;
                              if (backup) {
                                 getOrAddBroker(false, "\"" + backup + "\"", remoteBroker.nodeID, "remote", null, properties);
                                 addLinkIds("broker:"  + "\"" + remoteBroker.live + "\"", "broker:" + "\"" + backup + "\"", "network");
                              }
                           }
                           else {
                              var backup = remoteBroker.backup;
                              if (backup) {
                                 getOrAddBroker(false, "\"" + remoteBroker.backup + "\"", remoteBroker.nodeID, "remote", null, properties);
                                 addLinkIds("broker:" + broker.brokerId, "broker:" + "\"" + remoteBroker.backup + "\"", "network");
                              }
                           }
                        }
                     });
                     graphModelUpdated();
                  }));
               }
            });

            // find producers
            //todo Artemis doesnt support server side producer info but leaving this here in case its ever added
          /*  if ($scope.viewSettings.producer) {
               angular.forEach(brokers, function (brokerName) {
               mBean = artemisJmxDomain + ":type=Broker,brokerName=" + brokerName + ",module=JMS,serviceType=Server";
               ARTEMISService.artemisConsole.getProducers(mBean, containerJolokia, onSuccess(function (properties) {
                  producers = properties.value;
                  angular.forEach(angular.fromJson(producers), function (producer) {
                     if (producer) {

                        configureDestinationProperties(consumer);
                        var producerId = consumer.sessionID + ":" + consumer.producerID;
                        if (producerId) {
                           var destinationName = consumer.destinationName;
                           var typeName;
                           if (consumer.queueName) {
                              typeName = "Queue";
                           }
                           else {
                              typeName = "Topic"
                           }
                           var destination = getOrAddDestination(consumer, typeName, "\"" + destinationName + "\"", brokerName);
                           ARTEMIS.log.info("found " + destination);
                           if (destination) {
                              addLink(container.destinationLinkNode, destination, "destination");
                              var consumerNode = getOrAddNode("producer", producerId, producer, function () {
                                 return {
                                    typeLabel: "Producer",
                                    brokerContainer: container,
                                    //objectName: objectName,
                                    jolokia: containerJolokia,
                                    popup: {
                                       title: "Producer: " + producerId,
                                       content: "<p>client: " + (producer.connectionID || "") + "</p> " + brokerNameMarkup(brokerName)
                                    }
                                 };
                              });
                              addLink(destination, producerNode, "producer");
                           }
                        }
                     }
                  });
               }));
            });
            }*/
         }
      }

      function graphModelUpdated() {
         $scope.graph = graphBuilder.buildGraph();
         Core.$apply($scope);
      }

      function getOrAddBroker(master, brokerId, nodeId, containerId, container, brokerStatus) {
         var broker = null;
         var brokerFlag = master ? $scope.viewSettings.broker : $scope.viewSettings.slave;
         if (brokerFlag) {
            broker = getOrAddNode("broker", brokerId, brokerStatus, function () {
               return {
                  type: master ? "broker" : "brokerSlave",
                  typeLabel: master ? "Broker" : "Slave Broker",
                  popup: {
                     title: (master ? "Master" : "Slave") + " Broker: " + brokerId,
                     content: "<p>Container: " + containerId + "</p> Node ID: " + nodeId
                  }
               };
            });
            if (!broker['objectName']) {
               // lets try guess the mbean name
               broker['objectName'] = artemisJmxDomain + ":type=Broker,brokerName=" + brokerId + ",module=JMS,serviceType=Server";
               ARTEMIS.log.debug("Guessed broker mbean: " + broker['objectName']);
            }
            if (!broker['brokerContainer'] && container) {
               broker['brokerContainer'] = container;
            }
            if (!broker['nodeID']) {
               broker['nodeID'] = nodeId;
            }
         }
         return broker;
      }

      function getOrAddNode(typeName, id, properties, createFn) {
         var node = null;
         if (id) {
            var nodeId = typeName + ":" + id;
            node = graphBuilder.getNode(nodeId);
            if (!node) {
               var nodeValues = createFn();
               node = angular.copy(properties);

               angular.forEach(nodeValues, function (value, key) {
                  return node[key] = value;
               });
               node['id'] = nodeId;
               if (!node['type']) {
                  node['type'] = typeName;
               }
               if (!node['name']) {
                  node['name'] = id;
               }
               if (node) {
                  var size = $scope.shapeSize[typeName];
                  if (size && !node['size']) {
                     node['size'] = size;
                  }
                  if (!node['summary']) {
                     node['summary'] = node['popup'] || "";
                  }
                  if (!$scope.viewSettings.popup) {
                     delete node['popup'];
                  }
                  if (!$scope.viewSettings.label) {
                     delete node['name'];
                  }
                  // lets not add nodes which are defined as being disabled
                  var enabled = $scope.viewSettings[typeName];
                  if (enabled || !angular.isDefined(enabled)) {
                     graphBuilder.addNode(node);
                  }
                  else {
                  }
               }
            }
         }
         return node;
      }

      function addLink(object1, object2, linkType) {
         if (object1 && object2) {
            addLinkIds(object1.id, object2.id, linkType);
         }
      }

      function addLinkIds(id1, id2, linkType) {
         if (id1 && id2) {
            graphBuilder.addLink(id1, id2, linkType);
         }
      }

      function brokerNodeId(brokerId) {
         return brokerId ? "broker:" + brokerId : null;
      }

      /**
       * Avoid the JMX type property clashing with the ForceGraph type property; used for associating css classes with nodes on the graph
       *
       * @param properties
       */
      function renameTypeProperty(properties) {
         properties.mbeanType = properties['type'];
         delete properties['type'];
      }

      function configureDestinationProperties(properties) {
         renameTypeProperty(properties);
         var destinationType = properties.destinationType || "Queue";
         var typeName = destinationType.toLowerCase();
         properties.isQueue = !typeName.startsWith("t");
         properties['destType'] = typeName;
      }
   };

   return ARTEMIS;
} (ARTEMIS || {}));